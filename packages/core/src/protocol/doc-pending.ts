import type { DocId, Stamp } from "../ports.js";
import { stampsEqual } from "./stamp.js";

/**
 * Pure per-live-entry pending predicate — the exact clause SyncEngine.pendingDocs() applies to each
 * live index entry, lifted out so it is unit-testable without an engine. A doc is pending iff its
 * index stamp differs from the durable synced stamp (not yet acked by the relay) OR from the on-disk
 * content hash (content not yet materialized to disk). Uses hash-only equality via stampsEqual; `null`
 * models "no synced stamp yet" / "file absent on disk".
 */
export function isDocStampPending(
  entryStamp: Stamp,
  syncedStamp: Stamp | null,
  diskHash: Stamp | null,
): boolean {
  if (!stampsEqual(entryStamp, syncedStamp)) return true;
  if (!stampsEqual(entryStamp, diskHash)) return true;
  return false;
}

/** The per-entry facts {@link isDocArriving} decides on. `diskHash` is null when the file is
 *  absent from THIS device's disk. */
export interface ArrivingCheck {
  stuck: boolean;
  dirty: boolean;
  diskHash: Stamp | null;
}

/**
 * Pure "is this live entry INBOUND?" predicate — the display-only direction split behind the
 * status bar's "N arriving" segment. Three clauses; what's load-bearing is that STUCK and DIRTY
 * both precede the ABSENCE test below, and that the ABSENCE test is what it is rather than a
 * stamp-mismatch check (the relative order of STUCK vs. DIRTY is not itself significant — both
 * are terminal `return false` with no side effects):
 *
 *  - STUCK. `stuckDocIds` is drawn from `durablePendingDocs`, which explicitly includes
 *    unmaterialized content, so a stuck doc satisfies the absence clause FOREVER. Without this
 *    clause the arriving count can never reach zero.
 *  - DIRTY. A dirty doc owes a push; calling it arriving inverts the direction.
 *  - ABSENCE, deliberately NOT `disk !== stamp`. A stamp mismatch is ALSO true for a newer
 *    un-ingested external edit (edit with the app closed, reopen, look before bootstrap ingest
 *    runs), which `materializeLiveDiskContent`'s anti-clobber guard skips and the ingest path
 *    PUSHES. Absence is the only unambiguous inbound signal.
 *
 * Note the synced stamp is deliberately absent from this decision: on a fresh device it is null
 * for every doc, so any clause keyed on it would label an entire INCOMING vault as outbound.
 *
 * Callers must only apply this to entries already known pending; absence implies pending, so
 * `arriving` is a subset of `pending` by construction.
 */
export function isDocArriving(f: ArrivingCheck): boolean {
  if (f.stuck) return false;
  if (f.dirty) return false;
  return f.diskHash === null;
}

/**
 * A single O(n) pending pass, partitioned for DISPLAY. The three buckets are disjoint and
 * sum exactly to `pending`, so a UI never has to subtract (a plugin-side subtraction
 * double-counted the stuck/arriving overlap in review).
 *
 * `pending` keeps the meaning documented on `SyncEngine.pendingDocs` EXACTLY — stuck docs stay
 * inside it, because removing them would clear the self-heal stop latch and make `waitConverged`
 * lie. They are absent only from `arriving` and `sending`.
 *
 * UI HAZARD — render `stuck` FROM HERE, never `SyncEngine.stuckDocs().length`. This `stuck` is
 * filtered to docs that are actually pending; `stuckDocs()` is not, and the engine's stuck set only
 * clears when pending drains FULLY, so after a partial drain the two disagree. Mixing them makes
 * the rendered numbers stop summing — the exact double-count this partition exists to prevent.
 */
export interface SyncSnapshot {
  pending: DocId[];
  arriving: DocId[];
  sending: DocId[];
  stuck: DocId[];
}

/** One live index entry's contribution to the direction split, in scan order. */
export interface LiveEntryFacts {
  docId: DocId;
  /** That entry's on-disk content hash; null when the file is absent from THIS device. */
  diskHash: Stamp | null;
}

export interface PartitionInput {
  /** Exactly what `pendingDocs()` returns, in order. Passed through to `SyncSnapshot.pending`. */
  pending: DocId[];
  /** One record per LIVE INDEX ENTRY visited, INCLUDING entries that are not pending (see below). */
  live: LiveEntryFacts[];
  dirty: Set<DocId>;
  stuck: Set<DocId>;
}

/**
 * Fold per-entry facts into the display partition. PURE — the algebra of {@link SyncSnapshot},
 * lifted out of the engine's I/O loop so every awkward case is table-testable without a rig.
 *
 * `sending` is a SET DIFFERENCE (`pending` minus `stuck` minus `arriving`), never its own set of
 * clauses. `pending` draws from sources no per-entry classifier ever sees — dirty docIds with no
 * live entry, tombstoned-but-present paths, open rename transactions, and synthetic
 * `rename-target:<path>` tokens — and enumerating clauses for those would leave silent gaps. The
 * difference cannot, so the three buckets sum to `pending` by construction.
 *
 * A docId can be LIVE AT MORE THAN ONE PATH (a rename re-keys the index as two independent LWW
 * writes, so both keys are briefly live under one docId). Such a doc is arriving only when NO live
 * path is on disk. Folding this way is why `input.live` must carry entries that are NOT pending:
 * mid-rename the NEW path holds the file and is typically not pending while the OLD path is, so
 * dropping non-pending entries would hide the materialized side and show a purely OUTBOUND rename
 * as arriving — the direction inversion {@link isDocArriving} exists to prevent.
 *
 * `arriving` and `stuck` are both filtered to `pending`, so the sum invariant holds for any
 * DUPLICATE-FREE `pending`, even one whose sets otherwise disagree. (The engine's own inputs
 * already satisfy the stronger property anyway: a folded `diskHash` of null means every live path
 * was absent, and an absent path always makes its entry pending, since `stampsEqual(stamp, null)`
 * is false for any string stamp.)
 *
 * The duplicate-free precondition is real, not pedantry: `pending: ["a","a"]` with `a` arriving
 * yields `arriving: ["a"]` (the fold dedupes) and `sending: []` (the filter drops both copies), so
 * the buckets sum to 1 against a length of 2. The engine cannot hit this — it passes a set — but a
 * future caller that hand-builds `pending` could.
 */
export function partitionPending(input: PartitionInput): SyncSnapshot {
  const { pending, live, dirty, stuck } = input;
  const pendingSet = new Set<DocId>(pending);

  // Fold to ONE diskHash per docId, keeping a MATERIALIZED path if the doc has one.
  const diskHashOf = new Map<DocId, Stamp | null>();
  for (const entry of live)
    if ((diskHashOf.get(entry.docId) ?? null) === null) diskHashOf.set(entry.docId, entry.diskHash);

  const arriving: DocId[] = [];
  for (const [docId, diskHash] of diskHashOf)
    if (
      pendingSet.has(docId) &&
      isDocArriving({ stuck: stuck.has(docId), dirty: dirty.has(docId), diskHash })
    )
      arriving.push(docId);

  const arrivingSet = new Set<DocId>(arriving);
  const stuckPending = [...stuck].filter((id) => pendingSet.has(id));
  const stuckPendingSet = new Set<DocId>(stuckPending);
  const sending = pending.filter((id) => !stuckPendingSet.has(id) && !arrivingSet.has(id));
  return { pending, arriving, sending, stuck: stuckPending };
}
