import type { DocId, Sha256, VaultPath, VaultPort } from "../ports.js";
import type { IndexDoc } from "./index-doc.js";
import {
  applyResurrection,
  resolveTombstone,
  type ResurrectedNotice,
} from "../bridge/tombstone.js";
import { applyRenameConflictResolution } from "../bridge/rename.js";

/**
 * Injected SEAMS for the STRUCTURAL reconciler (0b-2 Tasks 1 + 2). The missing
 * inbound index→vault reconciler: when a tombstone replicates in from a peer, NO
 * existing path turned it into a removal (the C1 bug) OR a resurrection (the C3
 * bug) on this device. This module closes both gaps.
 *
 * Pure-core (no infra imports): it works only through the {@link IndexDoc} and
 * {@link VaultPort} ports plus a handful of behaviour seams, mirroring the
 * constructor/deps pattern of `protocol/lazy-attach.ts` and `bridge/ingest.ts`.
 */
export interface StructuralReconcileDeps {
  index: IndexDoc;
  vault: VaultPort;
  /**
   * Hash of the CURRENT on-disk content at `path`, or `null` if no local file
   * exists. SHARED by both concerns (delete + resurrect) so the disk read/hash
   * happens through one seam — the engine supplies the real vault-backed impl.
   */
  localHashOf: (path: VaultPath) => Promise<Sha256 | null>;
  /**
   * Mark a docId dirty so the next catch-up attaches it and pushes the resurrected
   * content upstream (the resurrecting device owes a re-push of its edited content).
   */
  markDirty: (docId: DocId) => Promise<void>;
  /** Surface a resurrection notice to the user's inbox (Concern 2). */
  onInboxNotice: (notice: ResurrectedNotice) => void;
}

/**
 * Reconcile the inbound INDEX against the local VAULT (0b-2 Tasks 1 + 2 + 5).
 *
 * For every TOMBSTONED entry (`deleted === true`) with a local file, the same
 * predicate — {@link resolveTombstone} — forks the delete-vs-resurrect decision
 * (single source of truth). On top of that, a renamed note's OLD key is ALSO a
 * tombstone — but its docId is still LIVE at the NEW key, so it is a MOVE, not a
 * deletion. The pass ordering and a docId-live-elsewhere guard keep the three
 * concerns from colliding:
 *
 * CONCERN 3 — RENAME PROPAGATION (M3). RUN FIRST. A docId whose LIVE index path
 * differs from where this device's file sits is a rename: a TOMBSTONED entry at
 * `oldPath` whose docId is ALSO bound LIVE at a different `newPath`, where the
 * device HAS a file at `oldPath` and NO file at `newPath`. Same docId = content
 * continuity (no content moves through the CRDT) → `vault.rename(oldPath, newPath)`.
 * After it runs, `oldPath` has no file, so the resurrect + delete passes skip it
 * (`localHashOf` → `null`). Divergent renames (one docId live at >1 path) are then
 * resolved DETERMINISTICALLY by {@link applyRenameConflictResolution}.
 *
 * CONCERN 2 — RESURRECT (edit-beats-delete, C3). `resolveTombstone` returns
 * `"resurrect"` iff the disk hash ≠ the tombstone's recorded hash: a concurrent
 * edit landed AFTER delete-time. {@link applyResurrection} re-lists the entry LIVE
 * at the disk hash (same `docId`/`type`) and emits an inbox notice; we then
 * `markDirty(docId)` so catch-up pushes the resurrected content. RUN before delete
 * so a contested path is never removed. SKIPS a tombstone whose docId is live
 * elsewhere (a move, not a content resurrection at the old path).
 *
 * CONCERN 1 — DELETE PROPAGATION (C1). `resolveTombstone` returns `"delete"` iff the
 * disk hash equals the tombstone hash: the delete is UNCONTESTED → `vault.remove`.
 * CRITICAL GUARD: SKIPS a tombstone whose docId is still LIVE at another path. A
 * renamed note's OLD-key tombstone records the (unchanged) content hash, so
 * `resolveTombstone` would say `"delete"` and WRONGLY remove the old file instead
 * of letting Concern 3 rename it. The guard makes a rename never a deletion.
 *
 * We iterate `index.entries()` — which INCLUDES tombstones — NOT `liveEntries()`.
 * A tombstone with no local file (`localHashOf` → `null`) is skipped by ALL
 * concerns: there is nothing to rename, resurrect, or remove. A minimal tombstone
 * (empty `stamp`) records no real content hash; its hash part can never equal a
 * real file's hash, so resolveTombstone would say "resurrect" — but the resurrect
 * pass below only acts when a local file EXISTS, and a path with no live docId
 * never re-pushes; in practice a minimal tombstone is laid only for a path that had
 * no entry (and thus no local prose to mis-resurrect).
 *
 * LOOP-SAFETY (rule D2). The DELETE concern issues `vault.remove` only and writes no
 * index/inbox — the engine's `onDelete` early-returns on an already-tombstoned
 * entry, so the fired "delete" event does not re-tombstone or relay. The RENAME
 * concern issues `vault.rename` only; its echoed "rename" event re-applies the move
 * that the index ALREADY reflects (new live + old tombstoned, same docId), which is
 * a no-op against that state — there is no content hash for a rename, so the
 * EchoLedger cannot suppress it; idempotency comes from the index state itself. The
 * divergent-rename resolver writes the index but is idempotent + convergent (D2):
 * once losers are tombstoned, ≤1 live → `null` → no-op.
 *
 * The RESURRECT concern WRITES the index (`setStamp` LIVE). This is convergent +
 * idempotent + locally-authoritative: ONLY the device whose LOCAL content ≠ the
 * tombstone hash resurrects (the edit owner), and only when a local file exists.
 * After it re-stamps LIVE at its own content hash, a re-run sees a LIVE entry
 * (`deleted !== true`) and skips it entirely → no-op, the storm cannot grow. Two
 * devices resurrecting byte-identical content settle because stamp equality is
 * hash-only (the device suffix differs, the hashes match).
 */
export async function runStructuralReconcile(deps: StructuralReconcileDeps): Promise<void> {
  const { index, vault, localHashOf, markDirty, onInboxNotice } = deps;

  // Reverse index: docId → its LIVE paths. A docId LIVE at any path makes a same-docId
  // tombstone a MOVE (rename loser / in-flight rename), never a deletion — used by the
  // rename concern (target lookup) and by the delete/resurrect guards below.
  const liveByDocId = new Map<DocId, VaultPath[]>();
  for (const [path, entry] of index.liveEntries()) {
    const paths = liveByDocId.get(entry.docId);
    if (paths === undefined) liveByDocId.set(entry.docId, [path]);
    else paths.push(path);
  }
  const isLiveElsewhere = (docId: DocId): boolean => (liveByDocId.get(docId)?.length ?? 0) > 0;

  // CONCERN 3 — RENAME PROPAGATION FIRST. A tombstoned `oldPath` whose docId is bound
  // LIVE at a DIFFERENT `newPath`, with a file at `oldPath` and none at `newPath`, is a
  // rename: move the file (content continuity, same docId) rather than delete it. Runs
  // before resurrect/delete so the old file is gone (→ skipped) by the time they run.
  for (const [oldPath, entry] of index.entries()) {
    if (entry.deleted !== true) continue;
    const liveTargets = liveByDocId.get(entry.docId);
    if (liveTargets === undefined) continue; // docId fully tombstoned → a real delete.
    if ((await localHashOf(oldPath)) === null) continue; // no file to move.
    // The rename TARGET: a live path for this docId that is NOT the old key and where
    // the device has no file yet. (Divergent renames may bind >1 live path; the
    // resolver below collapses them to one, then a later pass moves to the winner.)
    let target: VaultPath | undefined;
    for (const candidate of liveTargets) {
      if (candidate === oldPath) continue;
      if ((await localHashOf(candidate)) === null) {
        target = candidate;
        break;
      }
    }
    if (target === undefined) continue;
    await vault.rename(oldPath, target);
  }

  // DIVERGENT RENAME: any docId now LIVE at >1 path is a concurrent divergent rename.
  // Resolve DETERMINISTICALLY (lexicographic winner kept live, losers tombstoned). Gated
  // so it only writes when a conflict exists; idempotent + convergent (≤1 live → no-op).
  for (const [docId, paths] of liveByDocId) {
    if (paths.length <= 1) continue;
    applyRenameConflictResolution(index, docId);
  }

  // CONCERN 2 — RESURRECT (before delete): a contested path becomes LIVE before the
  // delete pass runs, so it can never be removed. SKIP a tombstone whose docId is live
  // elsewhere (a move, not a resurrection at the old path).
  for (const [path, entry] of index.entries()) {
    if (entry.deleted !== true) continue;
    if (isLiveElsewhere(entry.docId)) continue; // rename loser / move — not a resurrect.
    const diskHash = await localHashOf(path);
    if (diskHash === null) continue; // no local file → nothing to resurrect.
    if (resolveTombstone(entry, diskHash) !== "resurrect") continue;
    applyResurrection(index, path, entry, diskHash, onInboxNotice);
    await markDirty(entry.docId);
  }

  // CONCERN 1 — DELETE: any STILL-tombstoned entry whose disk content matches the
  // tombstone hash is an uncontested delete. SKIP a tombstone whose docId is still LIVE
  // at another path — that is a rename's old key (or a rename loser), not a deletion;
  // removing it would destroy the file Concern 3 means to rename.
  for (const [path, entry] of index.entries()) {
    if (entry.deleted !== true) continue;
    if (isLiveElsewhere(entry.docId)) continue; // move, not a delete.
    const diskHash = await localHashOf(path);
    if (diskHash === null) continue; // no local file → nothing to remove.
    if (resolveTombstone(entry, diskHash) === "delete") {
      await vault.remove(path);
    }
  }
}
