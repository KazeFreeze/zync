import type { DocId, VaultPath } from "../ports.js";

/**
 * RenameTransaction — a local, path-keyed TRANSACTION over the watcher fallout a real
 * recursive `fs.watch` emits AFTER a physical rename (0b-3, GPT-5.5 root cause).
 *
 * ## Why the one-shot RenameEcho was insufficient
 *
 * A rename moves a file with NO content change. The engine performs it via
 * `vault.rename(old, new)` (on the initiating device, or from structural reconcile on a
 * receiver) and re-keys the index — new key live, old key tombstoned, SAME docId
 * (content continuity). On the REAL filesystem the recursive watcher ALSO sees the
 * physical move and, after its coalesce window + an async `fs.stat`, emits stat-derived
 * `delete`/`modify` events — but ASYNC, possibly REORDERED, and possibly as a
 * `delete(newPath)` (the coalesced target probe racing a transient absence), not the
 * ideal synchronous `delete(old)+modify(new)` the prior {@link RenameEcho} modelled.
 *
 * The fatal residual: a `delete(newPath)` arrives for the path the rename just made
 * LIVE. A one-shot delete-echo keyed to `oldPath` does NOT suppress it → `onDelete`
 * tombstones the renamed (live) docId, then structural reconcile sees a fully-tombstoned
 * docId whose disk content matches the tombstone hash and `vault.remove`s the file. NET:
 * the renamed file is materialized on NEITHER device (incl. the originator that
 * physically had it), though the index/CRDT still answer with the continuous docId.
 *
 * ## Design — quarantine BOTH paths, then a settle reconcile
 *
 * When the engine observes a rename it OPENS a transaction over BOTH `oldPath` and
 * `newPath`:
 *   - {@link suppressDelete} returns `true` for EITHER path while the transaction is
 *     open — so neither a `delete(old)` NOR a `delete(new)` (in ANY order) can tombstone
 *     the live renamed docId or strand the old file. (The old file is already gone via
 *     the physical move; the index already tombstoned `oldPath` in the re-key, so
 *     suppressing `delete(old)` is also idempotent.)
 *   - {@link suppressModify} returns `true` for EITHER path while the transaction is
 *     open AND the disk hash equals the renamed content hash — so the rename's own
 *     `modify(new)` echo cannot re-stamp/re-mint the doc. A GENUINE later edit of the
 *     path (a DIFFERENT hash) passes through, so the window never mutes a real change.
 *
 * The transaction stays open for a BOUNDED settle window that RE-ARMS on every
 * suppressed event ({@link armSettle} is called by the engine each time a fallout event
 * is quarantined), so a late-arriving `delete(new)` after an early settle tick is still
 * caught. At settle the engine reconciles the invariant EXPLICITLY (old absent on disk;
 * new present — MATERIALIZING from the attached doc if the fallout removed it) and
 * CLOSES the transaction.
 *
 * NO-OP without fallout: with the in-process {@link FakeVault} (no watcher echo) no
 * events arrive, the settle fires once on its first scheduled tick, the reconcile finds
 * the invariant already holds (file present from the synthetic rename; index re-keyed),
 * and the transaction closes — so the existing synchronous-rename tests are unperturbed.
 *
 * It writes NO CRDT/index/inbox/blobs state — purely local engine bookkeeping (Maps), so
 * it is loop-discipline-safe.
 */
export interface RenameTxn {
  readonly oldPath: VaultPath;
  readonly newPath: VaultPath;
  readonly docId: DocId;
  /**
   * The renamed content hash (the entry's stamp hash) — a `modify(new)` whose disk hash
   * equals this is the rename's own echo. A plain `string` to match `stampHash`'s
   * return (a `Sha256` is assignable to it), so the engine can pass either.
   */
  readonly contentHash: string;
}

export class RenameTransaction {
  /** path → the open transaction that quarantines it (old AND new both map here). */
  readonly #byPath = new Map<VaultPath, RenameTxn>();
  /** The set of transactions currently open (keyed by newPath, the canonical id). */
  readonly #open = new Map<VaultPath, RenameTxn>();

  /**
   * Open a rename transaction `oldPath → newPath` for `docId` carrying `contentHash`.
   * Quarantines BOTH paths until the engine settles it. Idempotent for the same
   * newPath: a re-observed echo of the same rename refreshes the record in place.
   */
  open(oldPath: VaultPath, newPath: VaultPath, docId: DocId, contentHash: string): RenameTxn {
    const txn: RenameTxn = { oldPath, newPath, docId, contentHash };
    this.#open.set(newPath, txn);
    this.#byPath.set(oldPath, txn);
    this.#byPath.set(newPath, txn);
    return txn;
  }

  /**
   * Should a `delete(path)` be SUPPRESSED? `true` for either side of an open
   * transaction — the rename owns both paths, so no delete fallout (in any order,
   * incl. a `delete(new)`) may tombstone the live renamed entry or strand the old file.
   */
  suppressDelete(path: VaultPath): boolean {
    return this.#byPath.has(path);
  }

  /**
   * Should a `modify(path)` of content `diskHash` be SUPPRESSED? `true` for either side
   * of an open transaction WHEN `diskHash` equals the renamed content hash — the
   * rename's own echo. A genuine later edit (different hash) returns `false` and is
   * ingested normally, so the window is content-bound, never a blanket path mute.
   */
  suppressModify(path: VaultPath, diskHash: string): boolean {
    return this.#byPath.get(path)?.contentHash === diskHash;
  }

  /** The open transactions awaiting settle (snapshot — safe to iterate while closing). */
  openTransactions(): RenameTxn[] {
    return [...this.#open.values()];
  }

  /**
   * Close the transaction keyed by `newPath`, lifting the quarantine on both its paths.
   * Idempotent — a no-op if already closed.
   */
  close(newPath: VaultPath): void {
    const txn = this.#open.get(newPath);
    if (txn === undefined) return;
    this.#open.delete(newPath);
    // Only drop a path mapping if it still points at THIS txn (a later rename may have
    // re-claimed the path for a fresh transaction — do not lift its quarantine).
    if (this.#byPath.get(txn.oldPath) === txn) this.#byPath.delete(txn.oldPath);
    if (this.#byPath.get(txn.newPath) === txn) this.#byPath.delete(txn.newPath);
  }

  /**
   * Close EVERY open transaction and drop all quarantines. Called on `SyncEngine.stop()`
   * so a torn-down engine leaves no open transaction holding a path mute. Defensive —
   * harmless today since the instance is discarded with the engine, but correct.
   */
  closeAll(): void {
    this.#open.clear();
    this.#byPath.clear();
  }
}
