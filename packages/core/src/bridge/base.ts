import type { DocId, Sha256, VaultPath, VaultPort } from "../ports.js";

export interface BaseRecord {
  baseText: string; // the WORKING merge base TEXT — merge3 needs reconstructable text, not a one-way hash (NEW-7 BLOCKER-1)
  fileHash: Sha256; // quick compare / echo (the working base's hash)
  crdtToken: Uint8Array | null; // state vector; null = "adopt-pending" until first attach (0b-2 §A/§B)
  substrate: string;
  /**
   * The last RELAY-ACKED content TEXT — the CRASH-RECOVERY merge base (0b-3 crash-window no-loss).
   *
   * `baseText` is the WORKING base: a LOCAL ingest/reconcile advances it to the just-edited
   * content immediately (so the next ingest merges against it). But that edit may NOT have
   * reached the relay yet. If the device is SIGKILL'd in that window and restarts with a
   * PRISTINE/stale reloaded CRDT doc, reconciling against the WORKING base (== the edit) makes
   * `merge3(base=EDIT, disk=EDIT, crdt=PRISTINE)` see only the CRDT as changed → pristine wins
   * → the disk edit is REVERTED (silent data loss). So we ALSO persist `ackedText`: the content
   * the relay has actually confirmed receipt of (advanced ONLY by the catch-up ack gate and by
   * remote-origin outbound writes, whose content came FROM the relay). The crash-recovery dirty
   * reconcile uses `ackedText` as its merge base, so `merge3(acked=PRISTINE, disk=EDIT,
   * crdt=PRISTINE)` correctly keeps the DISK EDIT and re-pushes it.
   *
   * BACKWARD-COMPAT / ERGONOMICS: OPTIONAL on save — a caller that does not distinguish working
   * from acked (or an older on-disk record) omits them and {@link BaseStore.save}/{@link
   * BaseStore.load} default them to `baseText`/`fileHash` (fully-acked, correct for steady state).
   * Callers that must keep the recovery base LAGGING an unpushed edit (ingest, seed, the dirty
   * reconcile) set them explicitly. `load` ALWAYS returns them populated.
   */
  ackedText?: string;
  ackedHash?: Sha256; // the last-acked content's hash (the recovery anchor for the disk-ahead guard)
  /**
   * M1b: the content hash this device last OBSERVED present on disk for this docId — the durable
   * signal that later lets a closed-app delete be told apart from a never-written doc.
   *
   * UNLIKE the `acked*` fields above, this is NOT defaulted on load: an absent value stays absent
   * (`undefined`), because "never confirmed present" MUST stay distinguishable from a confirmed
   * delete. Defaulting it would silently assert presence the device never observed. The explicit
   * `| undefined` (under exactOptionalPropertyTypes) lets load/save round-trip an absent value.
   */
  materializedHash?: Sha256 | undefined;
}

interface SerializedBase {
  baseText: string;
  fileHash: Sha256;
  crdtTokenB64: string | null; // null mirrors an adopt-pending BaseRecord (crdtToken === null)
  substrate: string;
  ackedText?: string; // absent in pre-0b-3 records ⇒ defaults to baseText on load
  ackedHash?: Sha256; // absent in pre-0b-3 records ⇒ defaults to fileHash on load
  materializedHash?: Sha256 | undefined; // M1b: NOT defaulted on load — absent must stay absent
}

/**
 * Per-note base store (design §9.3). One small atomic file per note under
 * `<configDir>/zync/base/<docId>.json` — NOT one giant state.json (avoids O(n^2)
 * rewrites). Lives on the vault FS so base and note share a durability domain.
 * Writes base BEFORE the note file so a torn pair recovers safely.
 */
export class BaseStore {
  /** Per-doc serialization: chains all reads/writes of a given docId so a load-modify-save can't race. */
  private readonly locks = new Map<DocId, Promise<unknown>>();

  constructor(
    private readonly vault: VaultPort,
    private readonly configDir: string,
  ) {}

  private path(docId: DocId): VaultPath {
    return `${this.configDir}/zync/base/${docId}.json` as VaultPath;
  }

  private withDocLock<T>(docId: DocId, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(docId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      docId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  load(docId: DocId): Promise<BaseRecord | null> {
    return this.withDocLock(docId, () => this.loadUnlocked(docId));
  }

  save(docId: DocId, rec: BaseRecord): Promise<void> {
    return this.withDocLock(docId, () => this.saveUnlocked(docId, rec));
  }

  /**
   * Remove a doc's base record — the delete/tombstone cleanup (otherwise a deleted note leaves an
   * orphaned `<docId>.json` behind forever). Idempotent: every {@link VaultPort.remove} implementation
   * is a no-op on a missing file, so calling this for a doc that never had a base record is safe.
   */
  delete(docId: DocId): Promise<void> {
    return this.withDocLock(docId, () => this.vault.remove(this.path(docId)));
  }

  /** Atomic-ordering helper: base first, then the note file. */
  saveThenFile(
    docId: DocId,
    rec: BaseRecord,
    notePath: VaultPath,
    noteBytes: Uint8Array,
  ): Promise<void> {
    return this.withDocLock(docId, async () => {
      await this.saveUnlocked(docId, rec);
      await this.vault.writeAtomic(notePath, noteBytes);
    });
  }

  /** Serialized read-modify-write of a doc's base record. `fn` returns the record to persist, or
   *  null to leave it untouched. Callers MUST spread the loaded record to preserve every field. */
  async mutate(docId: DocId, fn: (rec: BaseRecord | null) => BaseRecord | null): Promise<void> {
    await this.withDocLock(docId, async () => {
      const cur = await this.loadUnlocked(docId);
      const next = fn(cur);
      if (next === null) return;
      await this.saveUnlocked(docId, next);
    });
  }

  /** M1b: record that this docId's content (hash) was observed present on disk, preserving all
   *  other fields. Idempotent: a no-op (no write) if the record is missing or already has this hash. */
  async markMaterialized(docId: DocId, hash: Sha256): Promise<void> {
    await this.mutate(docId, (rec) => {
      if (rec === null || rec.materializedHash === hash) return null;
      return { ...rec, materializedHash: hash };
    });
  }

  private async loadUnlocked(docId: DocId): Promise<BaseRecord | null> {
    const bytes = await this.vault.read(this.path(docId));
    if (bytes === null) return null;
    const s = JSON.parse(new TextDecoder().decode(bytes)) as SerializedBase;
    return {
      baseText: s.baseText,
      fileHash: s.fileHash,
      substrate: s.substrate,
      crdtToken: s.crdtTokenB64 === null ? null : b64ToBytes(s.crdtTokenB64),
      // Pre-0b-3 records have no acked* fields ⇒ treat the working base as fully-acked.
      ackedText: s.ackedText ?? s.baseText,
      ackedHash: s.ackedHash ?? s.fileHash,
      // M1b: NOT defaulted — absent must stay absent (never-confirmed vs confirmed-delete).
      materializedHash: s.materializedHash,
    };
  }

  private async saveUnlocked(docId: DocId, rec: BaseRecord): Promise<void> {
    const s: SerializedBase = {
      baseText: rec.baseText,
      fileHash: rec.fileHash,
      substrate: rec.substrate,
      crdtTokenB64: rec.crdtToken === null ? null : bytesToB64(rec.crdtToken),
      // Default an omitted acked base to the working base (fully-acked, steady-state semantics).
      ackedText: rec.ackedText ?? rec.baseText,
      ackedHash: rec.ackedHash ?? rec.fileHash,
      materializedHash: rec.materializedHash,
    };
    await this.vault.writeAtomic(this.path(docId), new TextEncoder().encode(JSON.stringify(s)));
  }
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
