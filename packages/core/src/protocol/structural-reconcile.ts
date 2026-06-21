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
  /**
   * Remove a doc's BASE record when its delete is applied here (Concern 1). The local-delete path
   * (`engine.onDelete`) removes the base directly, but an INBOUND tombstone removes the FILE here and
   * its echoed "delete" event hits an already-tombstoned entry → `onDelete` early-returns, so without
   * this seam the receiver's `<docId>.json` base record would be orphaned forever. Optional (no-op
   * default) so unit-test callers that don't assert base cleanup can omit it.
   */
  deleteBase?: (docId: DocId) => Promise<void>;
  /**
   * Remove the tombstoned doc's docStore (CRDT) snapshot. SAME inbound-tombstone rationale as
   * {@link deleteBase}: `engine.onDelete` removes the snapshot directly for a LOCAL delete, but an
   * INBOUND tombstone hits an already-tombstoned entry → `onDelete` early-returns, so without this
   * seam the receiver's IDB snapshot would be orphaned forever. Optional (no-op default).
   */
  deleteSnapshot?: (docId: DocId) => Promise<void>;
  /** Surface a resurrection notice to the user's inbox (Concern 2). */
  onInboxNotice: (notice: ResurrectedNotice) => void;
  /**
   * STABILITY GATE for divergent-rename resolution (0b-3, GPT-5.5 follow-up — torn-rename
   * race). A rename re-keys the index as TWO independent LWW writes (tombstone the old key,
   * set the new key live). They do NOT replicate atomically, so a RECEIVER can momentarily
   * observe BOTH the old key (not yet tombstoned) AND the new key live for the same docId —
   * a FALSE divergence. Resolving it (lexicographically) then tombstones the NEW path when
   * `old < new` and that tombstone propagates IRREVERSIBLY, destroying the rename everywhere.
   *
   * So the engine gates resolution behind STABILITY: `confirmDivergence(docId, livePaths)`
   * returns `true` only when the SAME divergence was observed on the PRIOR reconcile pass
   * (the engine records it and confirms on the next pass). A torn rename dissolves before
   * the next pass (the old-key tombstone arrives), so it is never resolved; a GENUINE
   * concurrent divergent rename persists across passes and resolves deterministically.
   * Omitted ⇒ resolve immediately (unit tests / single-pass callers that pass a settled
   * index). The engine ALWAYS records the current divergence (via the same seam) so the
   * NEXT pass can confirm it — recording is the seam's side effect.
   */
  confirmDivergence?: (docId: DocId, livePaths: VaultPath[]) => boolean;
  /**
   * S5 WORKSET SCOPE — when present, limits the tombstone loops (rename/resurrect/delete)
   * and the divergent-rename loop to paths/docIds reachable from the workset.
   *
   * `workset`: the set of docIds this observe-driven pass must process.
   * `allByDocId`: maps every docId → ALL its paths (live + tombstoned). Critically, a
   * rename's OLD-key tombstone is included here even though it is not a changed path —
   * this is what makes the workset's docId closure reach the old-key sibling so the rename
   * concern can act on it.
   *
   * When `undefined` (the FULL path), behavior is byte-for-byte unchanged.
   */
  scope?: {
    workset: ReadonlySet<DocId>;
    allByDocId: ReadonlyMap<DocId, VaultPath[]>;
  };
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
 * device HAS a file at `oldPath`. Same docId = content continuity (no content moves
 * through the CRDT). Two cases by whether the live target is already on disk:
 *   - NO file at `newPath` → `vault.rename(oldPath, newPath)` (move; the bytes carry).
 *   - `newPath` ALREADY materialized → the canonical content reached the new home
 *     INDEPENDENTLY (catch-up/`materializeLiveDiskContent` wrote it — the offline
 *     edit-then-rename case: the renamed doc carried a concurrent edit, so its content
 *     materialized at the new path BEFORE this pass, pre-empting the move). The file at
 *     `oldPath` is then a stranded leftover whose home is now `newPath` → `vault.remove`.
 *     Without this the old file lingers forever (rename finds no empty target → skips;
 *     delete skips a live-elsewhere docId), hanging `waitConverged` on `pendingDocs`'s
 *     tombstone-with-a-local-file clause.
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
 * concern issues `vault.rename` (move) OR `vault.remove` (stranded-old-file case) only,
 * never an index/inbox write. Its echoed "rename" event re-applies the move that the
 * index ALREADY reflects (new live + old tombstoned, same docId), which is a no-op
 * against that state (idempotency from the index state itself; no content hash, so the
 * EchoLedger cannot suppress a rename). Its `vault.remove(oldPath)` fires a "delete"
 * event on an ALREADY-tombstoned `oldPath`, so `onDelete` early-returns just as the
 * delete concern's removal does — no re-tombstone, no relay. The divergent-rename
 * resolver writes the index but is idempotent + convergent (D2): once losers are
 * tombstoned, ≤1 live → `null` → no-op.
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
  const deleteBase = deps.deleteBase ?? ((): Promise<void> => Promise.resolve());
  const deleteSnapshot = deps.deleteSnapshot ?? ((): Promise<void> => Promise.resolve());

  // Reverse index: docId → its LIVE paths. A docId LIVE at any path makes a same-docId
  // tombstone a MOVE (rename loser / in-flight rename), never a deletion — used by the
  // rename concern (target lookup) and by the delete/resurrect guards below.
  // ALWAYS built from the FULL index — NEVER scoped. A rename's old-key tombstone is only
  // recognised as a MOVE (not a delete) because its docId appears live elsewhere in this map.
  const liveByDocId = new Map<DocId, VaultPath[]>();
  for (const [path, entry] of index.liveEntries()) {
    const paths = liveByDocId.get(entry.docId);
    if (paths === undefined) liveByDocId.set(entry.docId, [path]);
    else paths.push(path);
  }
  const isLiveElsewhere = (docId: DocId): boolean => (liveByDocId.get(docId)?.length ?? 0) > 0;

  // S5 WORKSET SCOPE: when a scope is provided, restrict the tombstone loops and the
  // divergent-rename loop to the paths/docIds reachable from the workset.
  //
  // `scopedPaths`: gathered ONCE from `scope.allByDocId` (live + tombstoned siblings).
  // Critically, a rename's OLD-key tombstone is included because `allByDocId` maps the
  // docId to ALL its paths (not just the changed live key). Without the tombstoned old-key
  // the rename concern would never see the file that needs to be moved/removed.
  //
  // FRESHNESS INVARIANT: the paths list is computed once (path strings are stable — resurrect
  // re-lists LIVE but does not add/remove paths). Each loop body re-reads the entry FRESH via
  // `index.get(path)` so it sees mutations applied by earlier concerns (e.g. a resurrected
  // entry is LIVE when the delete loop runs, so `entry.deleted !== true` → skip — correct).
  //
  // When `scope === undefined` (the FULL path), the existing `index.entries()` iteration is
  // used — behavior byte-for-byte unchanged.
  let scopedPaths: VaultPath[] | null = null;
  if (deps.scope !== undefined) {
    const { workset, allByDocId } = deps.scope;
    const collected: VaultPath[] = [];
    for (const docId of workset) {
      const paths = allByDocId.get(docId);
      if (paths === undefined) continue;
      for (const p of paths) {
        collected.push(p);
      }
    }
    scopedPaths = collected;
  }

  // CONCERN 3 — RENAME PROPAGATION FIRST. A tombstoned `oldPath` whose docId is bound
  // LIVE at a DIFFERENT `newPath` is a MOVE (same docId = content continuity), not a
  // deletion. The device has a file at `oldPath`; what to do with it depends on whether
  // the live target is already materialized:
  //   - target has NO file yet → MOVE: `vault.rename(oldPath, newPath)` (content
  //     continuity carries the bytes; no CRDT round-trip needed).
  //   - target ALREADY has a file → the canonical content reached `newPath`
  //     INDEPENDENTLY (catch-up/materialize wrote it — the offline edit-then-rename
  //     case: the renamed doc carried a concurrent edit, so its content materialized at
  //     the new path before this pass, pre-empting the move). The file at `oldPath` is a
  //     stranded leftover whose home is now `newPath` → REMOVE it. Without this the old
  //     file lingers forever: the rename concern finds no empty target (skips) and the
  //     delete concern skips it (docId live elsewhere) → `pendingDocs`'s tombstone-with-
  //     file clause never clears → `waitConverged` hangs.
  // Runs before resurrect/delete so the old file is gone (→ skipped) by the time they run.
  if (scopedPaths !== null) {
    // SCOPED: iterate only the paths belonging to workset docIds (live + tombstoned siblings).
    for (const oldPath of scopedPaths) {
      const entry = index.get(oldPath);
      if (entry?.deleted !== true) continue;
      const liveTargets = liveByDocId.get(entry.docId);
      if (liveTargets === undefined) continue; // docId fully tombstoned → a real delete.
      if ((await localHashOf(oldPath)) === null) continue; // no file to move.
      // Find the rename TARGET: a live path for this docId that is NOT the old key. Prefer
      // an EMPTY target (→ rename/move). If every live target is already materialized, the
      // content reached the new home independently → the old file is removable.
      // (Divergent renames may bind >1 live path; the resolver below collapses them to one,
      // then a later pass settles to the winner.)
      let emptyTarget: VaultPath | undefined;
      let materializedTarget: VaultPath | undefined;
      for (const candidate of liveTargets) {
        if (candidate === oldPath) continue;
        if ((await localHashOf(candidate)) === null) {
          emptyTarget = candidate;
          break;
        }
        materializedTarget ??= candidate;
      }
      if (emptyTarget !== undefined) {
        await vault.rename(oldPath, emptyTarget);
      } else if (materializedTarget !== undefined && (await localHashOf(oldPath)) !== null) {
        // Live target already on disk → the old file is a stranded leftover → remove it.
        // RE-CHECK the old file still exists immediately before removing: a CONCURRENT
        // reconcile pass may have already moved it (the pure-move case where two passes
        // both saw the old file, one renamed it away). Without this re-check we would fire
        // a no-op `vault.remove` on an already-gone path — harmless to disk, but it makes a
        // pure move spuriously look like a delete. Skipping when gone keeps a true rename a
        // true rename (no remove) and only removes a genuinely-stranded leftover.
        await vault.remove(oldPath);
      }
    }
  } else {
    // FULL (unscoped): original behavior — iterate all index entries.
    for (const [oldPath, entry] of index.entries()) {
      if (entry.deleted !== true) continue;
      const liveTargets = liveByDocId.get(entry.docId);
      if (liveTargets === undefined) continue; // docId fully tombstoned → a real delete.
      if ((await localHashOf(oldPath)) === null) continue; // no file to move.
      // Find the rename TARGET: a live path for this docId that is NOT the old key. Prefer
      // an EMPTY target (→ rename/move). If every live target is already materialized, the
      // content reached the new home independently → the old file is removable.
      // (Divergent renames may bind >1 live path; the resolver below collapses them to one,
      // then a later pass settles to the winner.)
      let emptyTarget: VaultPath | undefined;
      let materializedTarget: VaultPath | undefined;
      for (const candidate of liveTargets) {
        if (candidate === oldPath) continue;
        if ((await localHashOf(candidate)) === null) {
          emptyTarget = candidate;
          break;
        }
        materializedTarget ??= candidate;
      }
      if (emptyTarget !== undefined) {
        await vault.rename(oldPath, emptyTarget);
      } else if (materializedTarget !== undefined && (await localHashOf(oldPath)) !== null) {
        // Live target already on disk → the old file is a stranded leftover → remove it.
        // RE-CHECK the old file still exists immediately before removing: a CONCURRENT
        // reconcile pass may have already moved it (the pure-move case where two passes
        // both saw the old file, one renamed it away). Without this re-check we would fire
        // a no-op `vault.remove` on an already-gone path — harmless to disk, but it makes a
        // pure move spuriously look like a delete. Skipping when gone keeps a true rename a
        // true rename (no remove) and only removes a genuinely-stranded leftover.
        await vault.remove(oldPath);
      }
    }
  }

  // DIVERGENT RENAME: any docId now LIVE at >1 path is EITHER a genuine concurrent divergent
  // rename OR the TORN-RENAME transient (old key not yet tombstoned + new key live; see
  // `confirmDivergence`). Resolve DETERMINISTICALLY (lexicographic winner kept live, losers
  // tombstoned) — but ONLY once the divergence is confirmed STABLE, so a torn rename (which
  // dissolves before the next pass) is never wrongly collapsed onto the old path. Gated so it
  // only writes when a conflict exists; idempotent + convergent (≤1 live → no-op).
  const confirm = deps.confirmDivergence ?? ((): boolean => true);
  if (scopedPaths !== null && deps.scope !== undefined) {
    // second clause narrows deps.scope for TS; equivalent to scopedPaths !== null
    // SCOPED: iterate only workset docIds and check their live-path count.
    // A divergence first appears when the rename's new key is changed (in the workset).
    // confirmDivergence adds unconfirmed docIds to pendingDivergenceDocIds; buildWorkset
    // unions pendingDivergenceDocIds into the workset every pass, so a divergent docId
    // remains in scope until resolved — the drain interaction is preserved.
    const { workset } = deps.scope;
    for (const docId of workset) {
      const paths = liveByDocId.get(docId);
      if (paths === undefined || paths.length <= 1) continue;
      if (!confirm(docId, paths)) continue; // torn-rename transient — await stability.
      applyRenameConflictResolution(index, docId);
    }
  } else {
    // FULL (unscoped): original behavior — iterate all of liveByDocId.
    for (const [docId, paths] of liveByDocId) {
      if (paths.length <= 1) continue;
      if (!confirm(docId, paths)) continue; // torn-rename transient — await stability.
      applyRenameConflictResolution(index, docId);
    }
  }

  // CONCERN 2 — RESURRECT (before delete): a contested path becomes LIVE before the
  // delete pass runs, so it can never be removed. SKIP a tombstone whose docId is live
  // elsewhere (a move, not a resurrection at the old path).
  if (scopedPaths !== null) {
    // SCOPED: re-read each entry FRESH (the divergent resolver may have tombstoned losers;
    // the entry's deleted flag must reflect the current state, not a stale snapshot).
    for (const path of scopedPaths) {
      const entry = index.get(path);
      if (entry?.deleted !== true) continue;
      if (isLiveElsewhere(entry.docId)) continue; // rename loser / move — not a resurrect.
      const diskHash = await localHashOf(path);
      if (diskHash === null) continue; // no local file → nothing to resurrect.
      if (resolveTombstone(entry, diskHash) !== "resurrect") continue;
      applyResurrection(index, path, entry, diskHash, onInboxNotice);
      await markDirty(entry.docId);
    }
  } else {
    // FULL (unscoped): original behavior.
    for (const [path, entry] of index.entries()) {
      if (entry.deleted !== true) continue;
      if (isLiveElsewhere(entry.docId)) continue; // rename loser / move — not a resurrect.
      const diskHash = await localHashOf(path);
      if (diskHash === null) continue; // no local file → nothing to resurrect.
      if (resolveTombstone(entry, diskHash) !== "resurrect") continue;
      applyResurrection(index, path, entry, diskHash, onInboxNotice);
      await markDirty(entry.docId);
    }
  }

  // CONCERN 1 — DELETE: any STILL-tombstoned entry whose disk content matches the
  // tombstone hash is an uncontested delete. SKIP a tombstone whose docId is still LIVE
  // at another path — that is a rename's old key (or a rename loser), not a deletion;
  // removing it would destroy the file Concern 3 means to rename.
  if (scopedPaths !== null) {
    // SCOPED: re-read each entry FRESH (resurrect may have re-listed a path LIVE; the
    // freshness invariant ensures we never delete a just-resurrected file).
    for (const path of scopedPaths) {
      const entry = index.get(path);
      if (entry?.deleted !== true) continue;
      if (isLiveElsewhere(entry.docId)) continue; // move, not a delete.
      const diskHash = await localHashOf(path);
      if (diskHash === null) continue; // no local file → nothing to remove.
      if (resolveTombstone(entry, diskHash) === "delete") {
        await vault.remove(path);
        // Clean up the now-deleted doc's base record AND docStore snapshot. The fired "delete"
        // event reaches an already-tombstoned entry, so `onDelete` early-returns without removing
        // them — do it here.
        await deleteBase(entry.docId);
        await deleteSnapshot(entry.docId);
      }
    }
  } else {
    // FULL (unscoped): original behavior.
    for (const [path, entry] of index.entries()) {
      if (entry.deleted !== true) continue;
      if (isLiveElsewhere(entry.docId)) continue; // move, not a delete.
      const diskHash = await localHashOf(path);
      if (diskHash === null) continue; // no local file → nothing to remove.
      if (resolveTombstone(entry, diskHash) === "delete") {
        await vault.remove(path);
        // Clean up the now-deleted doc's base record AND docStore snapshot. The fired "delete"
        // event reaches an already-tombstoned entry, so `onDelete` early-returns without removing
        // them — do it here.
        await deleteBase(entry.docId);
        await deleteSnapshot(entry.docId);
      }
    }
  }
}
