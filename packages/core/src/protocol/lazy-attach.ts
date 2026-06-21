import type {
  AttachedDoc,
  CrdtDoc,
  CrdtProvider,
  DeviceId,
  DocId,
  DocStorePort,
  EngineStateStore,
  Sha256,
  TransportPort,
  VaultPath,
} from "../ports.js";
import { sha256OfText } from "../hash.js";
import type { IndexDoc, TreeEntry } from "./index-doc.js";
import { makeStamp, stampsEqual } from "./stamp.js";

export interface LazyAttachDeps {
  index: IndexDoc;
  engineState: EngineStateStore;
  transport: TransportPort;
  provider: CrdtProvider;
  docStore: DocStorePort;
  /**
   * This device's id — the provenance suffix for the synced stamp recorded after a
   * successful attach. Equality is HASH-ONLY ({@link stampsEqual}), so the suffix
   * never affects convergence; it is recorded for parity with every other stamp the
   * engine writes (`makeStamp(sha, deviceId)`). Defaults to a fixed placeholder.
   */
  deviceId?: DeviceId;
  /** Max attach operations in flight at once (default 6). */
  concurrency?: number;
  /**
   * Bound (ms) on awaiting a doc's relay ACK before retiring its push obligation (default
   * {@link ACK_TIMEOUT_MS}). On timeout the doc stays dirty + its synced stamp unadvanced so it
   * re-pushes next cycle (see {@link LazyAttachManager.awaitAckBounded}). Lowered in unit tests
   * that deliberately hold the ack pending so they don't pay the full production bound.
   */
  ackTimeoutMs?: number;
  /**
   * OPTIONAL seam (Task 13): invoked right after a successful `transport.attach`
   * for a materialized note doc, BEFORE `synced()` is awaited. The engine uses it
   * to wire the OUTBOUND pipeline (so remote updates on this doc reach disk) and to
   * record the doc as attached. Omitted in unit tests — purely additive.
   */
  onAttached?: (doc: CrdtDoc) => void;
  /**
   * OPTIONAL seam (Task 7): invoked alongside `onAttached`, passing BOTH the doc
   * AND the `AttachedDoc` handle returned by `transport.attach`. The engine stores
   * this handle in its `attachedHandles` map so `stop()` can call `.detach()` on
   * every note doc (M4 — the leak that left bus peers + onUpdate subscriptions live
   * after stop()). Omitted in unit tests — the handle was always discarded there.
   */
  onAttachedHandle?: (docId: DocId, handle: AttachedDoc) => void;
  /**
   * OPTIONAL seam (Task 13b Part 2): return the engine's CANONICAL already-attached
   * doc for `docId`, or `undefined`. When present, catch-up REUSES it instead of
   * re-materializing a fresh doc — re-materializing would orphan the live doc
   * (losing its content + outbound subscription) and is what stranded offline-origin
   * edits. Omitted in unit tests (always materializes fresh).
   */
  getAttached?: (docId: DocId) => CrdtDoc | undefined;
  /**
   * OPTIONAL seam (0b-3 Fix 5): return the engine's live `AttachedDoc` handle for `docId`, or
   * `undefined`. The catch-up worker awaits this handle's `acked()` to gate dirty-clear/synced-
   * advance on a relay receipt confirmation (closing the crash-window data-loss class). Used for
   * REUSED already-attached docs whose handle the manager itself did not mint (the engine surfaces
   * it from its `attachedHandles` map). The manager ALSO records every handle it mints, so this is
   * a fallback the engine wires; omitted in unit tests, which reuse via the manager's own map.
   */
  getAttachedHandle?: (docId: DocId) => AttachedDoc | undefined;
  /**
   * OPTIONAL seam (Task 13b Part 2): push this device's local-origin content into a
   * freshly-attached (or reused) + synced doc — the adopt-pending materialization a
   * note created/edited while its doc was NOT attached needs to actually propagate.
   * The engine no-ops it unless the doc is dirty. Omitted in unit tests.
   */
  reconcileLocal?: (doc: CrdtDoc) => Promise<void>;
  /**
   * OPTIONAL seam (0b-3 crash-window no-loss): the relay has CONFIRMED RECEIPT of this doc's
   * pushed content AND that content matches the current index entry (nothing newer is pending),
   * so the engine may now advance the doc's ACKED/recovery base to the doc's current text — the
   * content that is genuinely on the relay. Called right before {@link engineState.clearDirty},
   * under the SAME stamp-equality gate, so it never advances the acked base to an UNPUSHED edit
   * that landed during the window (offline-edit safety). Omitted in unit tests — purely additive.
   */
  onPushAcked?: (doc: CrdtDoc) => Promise<void>;
  /**
   * OPTIONAL seam (0b-3 Fix 6 — clean-settle): the on-disk content hash for `docId`'s live
   * vault path, or `null` when no local file exists. Used ONLY by {@link
   * LazyAttachManager.settleCleanDocs} to prove a doc has fully converged (attached doc text hash
   * == on-disk content hash == index entry stamp hash) before re-advancing its synced stamp to
   * the agreed hash. The manager has no vault port, so the engine supplies the hash via this
   * read-only seam (it reads `vault.read` + hashes; writes nothing). Omitted in unit tests that
   * do not exercise clean-settle.
   */
  diskHashOf?: (docId: DocId) => Promise<Sha256 | null>;
  /**
   * OPTIONAL seam (S6a — self-draining backstops): invoked when a GENUINELY NEW docId is
   * enqueued into {@link LazyAttachManager.remoteUpdatedSinceSettle} or
   * {@link LazyAttachManager.needsCatchUp} (i.e. the docId was not already in the set — a
   * re-add of a present docId must NOT invoke this callback, which is the anti-spin guarantee).
   *
   * The engine wires this to set `freshBackstopWork = true` and call `scheduleReconcile()` so
   * the reconcile loop re-runs for backstop-only work even when no further `index.observe` fires.
   * Omitted in unit tests that do not exercise the self-draining loop.
   */
  onBackstopWork?: () => void;
}

/** One path/entry pair selected for catch-up. */
interface CatchUpItem {
  path: VaultPath;
  entry: TreeEntry;
}

/**
 * Optional scope for {@link LazyAttachManager.computeCatchUpSet} and
 * {@link LazyAttachManager.runCatchUp}. When provided, only docIds in `workset`
 * are iterated (instead of all live index entries). `liveByDocId` maps each
 * workset docId to its live vault path(s) — used both for the per-docId scan
 * AND for the prune/drain logic in the post-loop needsCatchUp sweep.
 *
 * `workset ⊇ {open ∪ dirty ∪ needsCatchUp ∪ changed-paths ∪ divergence ∪ remoteUpdated}`
 * is the CORRECTNESS INVARIANT maintained by `buildWorksetWithMaps` in engine.ts.
 * It guarantees the scoped scan is a SUPERSET of what the full scan would select
 * for catch-up. Do not weaken it.
 *
 * When `scope` is `undefined`, the FULL path (all live entries) is used — byte-for-byte
 * identical to the pre-S4b behavior. Only the scoped branch is new code.
 */
interface CatchUpScope {
  workset: ReadonlySet<DocId>;
  liveByDocId: ReadonlyMap<DocId, VaultPath[]>;
}

const DEFAULT_CONCURRENCY = 6;

/**
 * Bound (ms) on awaiting a doc's relay ACK before retiring its push obligation. If the relay
 * does NOT confirm receipt within this window, catch-up leaves the doc dirty + its synced stamp
 * unadvanced so it re-pushes next cycle — `pendingDocs` keeps it pending, `waitConverged` re-runs
 * catch-up, and a genuinely stuck ack surfaces as a VISIBLE `waitConverged` non-settle, never
 * silent loss. Generous so a slow-but-live relay still acks within one pass.
 */
const ACK_TIMEOUT_MS = 10_000;

/**
 * Lazy-attach + catch-up manager (0b-2 §B).
 *
 * The index doc stays attached on every device; note docs attach LAZILY. A note's
 * doc must attach iff it is OPEN, or its tree stamp does NOT equal the last synced
 * stamp this device reconciled for that doc, or it is DIRTY (owes an upstream
 * re-push after reconnect).
 *
 * THE TRIGGER IS INEQUALITY, never ordering. Tree entries are per-key LWW Y.Map
 * registers; a concurrent bump can make either side "win", so a greater-than test
 * would silently skip real changes. All comparisons use the HASH PART only, via
 * {@link stampsEqual}. Because the synced stamp is recorded per doc, an identical
 * vault adopted from scratch can be detected as already-synced from the index +
 * engine-state ALONE — zero note attaches, zero wasted network.
 */
export class LazyAttachManager {
  private readonly index: IndexDoc;
  private readonly engineState: EngineStateStore;
  private readonly transport: TransportPort;
  private readonly provider: CrdtProvider;
  private readonly docStore: DocStorePort;
  private readonly deviceId: DeviceId;
  private readonly concurrency: number;
  private readonly ackTimeoutMs: number;
  private readonly onAttached: ((doc: CrdtDoc) => void) | undefined;
  private readonly onAttachedHandle: ((docId: DocId, handle: AttachedDoc) => void) | undefined;
  private readonly getAttached: ((docId: DocId) => CrdtDoc | undefined) | undefined;
  private readonly getAttachedHandle: ((docId: DocId) => AttachedDoc | undefined) | undefined;
  private readonly reconcileLocal: ((doc: CrdtDoc) => Promise<void>) | undefined;
  private readonly onPushAcked: ((doc: CrdtDoc) => Promise<void>) | undefined;
  private readonly diskHashOf: ((docId: DocId) => Promise<Sha256 | null>) | undefined;
  private readonly onBackstopWork: (() => void) | undefined;
  /**
   * DocIds for which a materialize+attach is currently in progress (reserved
   * BEFORE the first `await`). A concurrent pass that sees a docId here skips
   * it — preventing the double-attach race that would strand a zombie bus peer.
   */
  private readonly attaching = new Set<DocId>();
  /**
   * DocId → its live `AttachedDoc` handle. Populated on every fresh `transport.attach`
   * (alongside `onAttachedHandle`) so a LATER catch-up pass that REUSES an already-attached
   * doc (the `getAttached` path) can still reach its `acked()` to gate dirty-clear — WITHOUT
   * re-attaching (which would violate the no-re-attach contract). The transport's own `attach`
   * is idempotent, so even a handle that predates this map is the same underlying attachment.
   */
  private readonly handles = new Map<DocId, AttachedDoc>();

  // ── Stage 3: retained backstop sets ────────────────────────────────────
  //
  // These sets were INERT in Stage 3 (passes were still FULL at that point). They are now
  // ACTIVE: since S4b both sets are unioned into the scoped workset by buildWorksetWithMaps,
  // and since S6a they self-drain via onBackstopWork without requiring an unrelated index event.
  // They are also the ONLY trigger for a scoped settle that converges via a remote note-doc
  // update with no concurrent index-key change (the clean-settle latch fixed in S6b).

  /**
   * DocIds of attached docs that received a `"remote"`-origin note-doc update since the
   * last settle pass. Enqueued O(1) from {@link noteRemoteUpdate} (called by
   * `engine.bindOutbound`'s `doc.onUpdate(origin === "remote")` callback). Drained by
   * {@link settleCleanDocs} when a docId is observed SETTLED (syncedStamp == index stamp)
   * or NON-ACTIONABLE (no live entry / doc not attached / no diskHashOf seam).
   *
   * WHY NEEDED (S4+): a doc can converge via a remote note-doc update with NO index-key
   * change. A scoped settle (S6) would never re-select it → false-pending latch. This set
   * gives settle a trigger so it visits every remote-updated doc regardless of index delta.
   * (Risk #1 in CURSOR-GPT-KEYSCOPED-RECONCILE-FINDINGS.md.)
   *
   * ACTIVE-BOUND CARVE-OUT (S6a): `engine.bindOutbound` enqueues here ONLY for docs that are
   * NOT active-bound (it calls {@link noteRemoteUpdate} AFTER its active-bound guard). An
   * active-bound doc converges via the editor autosave → ingest → index-bump chain and is
   * always in `openDocIds` (hence always in the workset), so it never needs this trigger;
   * enqueuing it would fire the self-draining loop and advance its synced stamp to the merged
   * CRDT hash while the index stamp is still pre-merge → a false-pending spin. Any new enqueue
   * site for this set must preserve that carve-out.
   */
  private readonly remoteUpdatedSinceSettle = new Set<DocId>();

  /**
   * DocIds whose last catch-up pass did NOT prove stamp equality after the ack gate —
   * either because the ack timed out/dropped (`if (!acked) return` path), or because
   * `setSyncedStamp` ran but `stampsEqual(syncedStamp, currentStamp)` was false (doc
   * selected, not converged). Also populated when a precheck finds index.stamp !=
   * syncedStamp (the S4 hook in `computeCatchUpSet`). Drained when a pass PROVES
   * equality (the `clearDirty` path, or `stampsEqual` → true after re-read). Pruned of
   * docIds with no live index entry on every pass (bounded).
   *
   * WHY NEEDED (S4+): under scoping, a doc whose ack-gated catch-up did not complete
   * would be stranded until an unrelated index change re-selects it. This set forces it
   * back into the workset. (Risk #2 in CURSOR-GPT-KEYSCOPED-RECONCILE-FINDINGS.md.)
   */
  private readonly needsCatchUp = new Set<DocId>();

  constructor(deps: LazyAttachDeps) {
    this.index = deps.index;
    this.engineState = deps.engineState;
    this.transport = deps.transport;
    this.provider = deps.provider;
    this.docStore = deps.docStore;
    this.deviceId = deps.deviceId ?? ("__lazy_attach__" as DeviceId);
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.ackTimeoutMs = deps.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.onAttached = deps.onAttached;
    this.onAttachedHandle = deps.onAttachedHandle;
    this.getAttached = deps.getAttached;
    this.getAttachedHandle = deps.getAttachedHandle;
    this.reconcileLocal = deps.reconcileLocal;
    this.onPushAcked = deps.onPushAcked;
    this.diskHashOf = deps.diskHashOf;
    this.onBackstopWork = deps.onBackstopWork;
  }

  // ── Stage 3 public API — backstop-set seams ─────────────────────────────

  /**
   * Enqueue `docId` into {@link remoteUpdatedSinceSettle}. Called by the engine's
   * `bindOutbound` whenever a `"remote"`-origin note-doc update lands on an attached
   * doc (regardless of the active-bound guard — the doc still needs settling even if
   * the editor handles the disk write). O(1); no I/O.
   */
  noteRemoteUpdate(docId: DocId): void {
    // S6a: only invoke onBackstopWork when the docId is GENUINELY NEW to the set — a re-add
    // of an already-present docId must NOT notify (anti-spin guarantee: a persistent remote
    // update on the same doc does not set freshBackstopWork repeatedly). Check before add so
    // the "new" vs "existing" classification is unambiguous.
    const isNew = !this.remoteUpdatedSinceSettle.has(docId);
    this.remoteUpdatedSinceSettle.add(docId);
    if (isNew) this.onBackstopWork?.();
  }

  /**
   * Enqueue `docId` into {@link needsCatchUp}. Test seam (also used internally).
   * External callers (tests / S4 scoping) use this to force a doc back into the
   * catch-up workset without triggering a full reconcile pass.
   */
  addNeedsCatchUp(docId: DocId): void {
    // Routes through enqueueNeedsCatchUp so the S6a genuinely-new guard and onBackstopWork
    // notification are applied identically for the test seam and all internal callers.
    this.enqueueNeedsCatchUp(docId);
  }

  /**
   * READ-ONLY snapshot of {@link remoteUpdatedSinceSettle} for test assertions and
   * observability. Returns a fresh `Set` copy so callers cannot mutate internal state.
   */
  remoteUpdatedSinceSettleSnapshot(): ReadonlySet<DocId> {
    return new Set(this.remoteUpdatedSinceSettle);
  }

  /**
   * READ-ONLY snapshot of {@link needsCatchUp} for test assertions and observability.
   * Returns a fresh `Set` copy so callers cannot mutate internal state.
   */
  needsCatchUpSnapshot(): ReadonlySet<DocId> {
    return new Set(this.needsCatchUp);
  }

  /**
   * S6a: internal helper — add docId to needsCatchUp with the "genuinely new" guard.
   * Only invokes {@link onBackstopWork} when the docId was not already in the set — a
   * re-add of a present docId does NOT notify (anti-spin guarantee). Used at every
   * internal needsCatchUp.add site.
   */
  private enqueueNeedsCatchUp(docId: DocId): void {
    const isNew = !this.needsCatchUp.has(docId);
    this.needsCatchUp.add(docId);
    if (isNew) this.onBackstopWork?.();
  }

  /**
   * The set of docs to attach right now, as `{ path, entry }` pairs:
   *   { open } ∪ { tree stamp ≠ synced stamp } ∪ { dirty (re-push on connect) }.
   * De-duplicated by `docId`. Selection is PURE INEQUALITY — never ordering.
   *
   * @param openDocIds - docIds currently open (active-bound); always selected.
   * @param scope - S4b scoping (optional). When provided, iterates only `scope.workset`
   *   docIds using `scope.liveByDocId` to expand each to its live paths — O(workset)
   *   instead of O(n) for the full index. When `undefined`, falls back to the full
   *   `index.liveEntries()` scan (byte-for-byte identical to the pre-S4b behavior).
   *
   * CORRECTNESS (post-F1): `scope.workset ⊇ {open ∪ needsCatchUp ∪ changed-paths ∪
   * divergence ∪ remoteUpdated}` is upheld by `buildWorksetWithMaps`. The full DIRTY set is
   * DELIBERATELY NOT unioned into the scoped workset (F1 — it made every scoped pass O(n)
   * during a bulk first sync, defeating the scoping). So the scoped iteration selects a strict
   * SUBSET of the full scan: it drops offline-dirty docs that aren't otherwise in scope, which
   * are re-pushed by a FULL pass instead (startup step 9 / the reconnect onStatus backstop /
   * the S6c audit / waitConverged — all keep the full `listDirty()` union). Do NOT "restore"
   * the dirty union here — that re-introduces the O(n2) first sync.
   */
  async computeCatchUpSet(openDocIds: Set<DocId>, scope?: CatchUpScope): Promise<CatchUpItem[]> {
    const byDocId = new Map<DocId, CatchUpItem>();
    const pathByDocId = new Map<DocId, CatchUpItem>();

    if (scope === undefined) {
      // ── FULL PATH (scope undefined) — byte-for-byte identical to pre-S4b ─────
      for (const [path, entry] of this.index.liveEntries()) {
        // Remember a path for every live docId so dirty docs can map back to a path.
        pathByDocId.set(entry.docId, { path, entry });

        if (openDocIds.has(entry.docId)) {
          byDocId.set(entry.docId, { path, entry });
          continue;
        }
        const synced = await this.engineState.getSyncedStamp(entry.docId);
        if (!stampsEqual(entry.stamp, synced)) {
          byDocId.set(entry.docId, { path, entry });
          // Stage 3: ENQUEUE into needsCatchUp — this precheck found index.stamp != syncedStamp.
          // Per the spec (Cross-model review item 3), needsCatchUp must contain docIds with known
          // index.stamp != syncedStamp so a scoped pass (S4+) can force them into the workset.
          // Under S3 full passes this enqueues every mismatched doc each pass and the drain in the
          // post-loop block removes them as they converge — correct + harmless (pure bookkeeping;
          // the full scan still does the real work).
          // S6a: use enqueueNeedsCatchUp to fire onBackstopWork only when genuinely new (anti-spin).
          this.enqueueNeedsCatchUp(entry.docId);
        }
      }

      // Union in dirty docs (re-push on connect), mapping each back to its index path.
      // A dirty docId with no live index entry is skipped (nothing to re-push against).
      for (const dirtyId of await this.engineState.listDirty()) {
        if (byDocId.has(dirtyId)) continue;
        const item = pathByDocId.get(dirtyId);
        if (item !== undefined) byDocId.set(dirtyId, item);
      }

      // Stage 3: prune and drain needsCatchUp entries:
      //   - PRUNE docIds with no live index entry (deleted/gone) — keep the set bounded.
      //   - DRAIN docIds whose stamps are NOW EQUAL — they have been caught up by a prior pass
      //     (e.g. added via addNeedsCatchUp, then a runCatchUp or waitConverged advanced the
      //     synced stamp independently). Re-read the stamp here (same I/O as the main loop)
      //     rather than relying solely on the ack path in runCatchUp's worker.
      // No extra I/O for docs that are NOT in needsCatchUp — this loop is bounded by the set.
      for (const docId of this.needsCatchUp) {
        const liveItem = pathByDocId.get(docId);
        if (liveItem === undefined) {
          // No live entry — prune (deleted / no path to catch up to).
          this.needsCatchUp.delete(docId);
          continue;
        }
        // Drain if stamps are equal (the doc has been fully caught up already).
        const syncedStamp = await this.engineState.getSyncedStamp(docId);
        if (stampsEqual(liveItem.entry.stamp, syncedStamp)) {
          this.needsCatchUp.delete(docId);
        }
        // If stamps differ, leave the docId in the set — it still needs catch-up work.
      }
    } else {
      // ── SCOPED PATH (S4b) — iterate only workset docIds ──────────────────────
      // workset ⊇ {open ∪ needsCatchUp ∪ changed-paths ∪ divergence ∪ remoteUpdated} is upheld
      // by buildWorksetWithMaps. NOTE (F1): the full DIRTY set is NOT in the workset — a dirty
      // workset doc is still caught up (the isDirty() check below), but an offline-dirty doc not
      // otherwise in scope is left to a FULL pass (reconnect/audit). So this scan selects a SUBSET
      // of the full scan, by design — without reading the O(n) full index every pass.
      for (const docId of scope.workset) {
        const livePaths = scope.liveByDocId.get(docId);
        if (livePaths === undefined) {
          // docId has no live entry (deleted / tombstoned) — skip. It will be pruned from
          // needsCatchUp below if present.
          continue;
        }
        for (const path of livePaths) {
          const entry = this.index.get(path);
          // Defensive guard: entry may be absent or tombstoned (liveByDocId is built from
          // the full index pre-batch, but a concurrent deletion could tombstone the entry
          // by the time we read here — extremely rare safety net).
          if (entry === undefined || entry.deleted === true) continue;

          // Record this path as the representative live path for this docId (for dirty union
          // and needsCatchUp prune/drain below).
          pathByDocId.set(entry.docId, { path, entry });

          if (openDocIds.has(entry.docId)) {
            byDocId.set(entry.docId, { path, entry });
            continue;
          }
          const synced = await this.engineState.getSyncedStamp(entry.docId);
          if (!stampsEqual(entry.stamp, synced)) {
            byDocId.set(entry.docId, { path, entry });
            // Enqueue: precheck found index.stamp != syncedStamp; force retry on next scoped pass
            // even if no index key change re-selects this docId.
            // S6a: use enqueueNeedsCatchUp to fire onBackstopWork only when genuinely new (anti-spin).
            this.enqueueNeedsCatchUp(entry.docId);
          }
        }
      }

      // Union in dirty workset docs.
      //
      // F1: the dirty union previously called listDirty() — an O(n) scan during a bulk first
      // sync where every doc is dirty, making the scoped path O(n) per pass → O(n^2) total.
      // The full listDirty() union was removed from buildWorksetWithMaps (engine.ts) for the
      // same reason. Here we replace it with per-workset isDirty() checks — O(workset), not
      // O(n_dirty). A dirty doc in the workset gets the same treatment; a dirty doc NOT in the
      // workset is re-pushed via a FULL pass (startup / reconnect / S6c audit / waitConverged).
      for (const docId of scope.workset) {
        if (byDocId.has(docId)) continue; // already selected (open or stamp-mismatch)
        const item = pathByDocId.get(docId);
        if (item === undefined) continue; // no live entry (deleted/tombstoned) — skip
        if (await this.engineState.isDirty(docId)) {
          byDocId.set(docId, item);
        }
      }

      // Prune and drain needsCatchUp — scoped variant.
      // needsCatchUp ⊆ workset (buildWorksetWithMaps unions it), so every needsCatchUp docId
      // was visited in the workset loop above and is in pathByDocId if it has a live entry.
      // HOWEVER: to make the "has live entry?" determination robust and independent of the
      // scoped subset, we resolve against the FULL scope.liveByDocId: a needsCatchUp docId
      // with scope.liveByDocId.get(docId) === undefined truly has no live entry → prune.
      for (const docId of this.needsCatchUp) {
        const livePaths = scope.liveByDocId.get(docId);
        if (livePaths === undefined) {
          // No live entry — prune (deleted / no path to catch up to).
          this.needsCatchUp.delete(docId);
          continue;
        }
        // Resolve a live path to get the current entry for stamp comparison. Under
        // noUncheckedIndexedAccess `livePaths[0]` is `VaultPath | undefined`; liveByDocId
        // only records a docId when it has >=1 live path, so the guard below is a safety
        // net (prune rather than strand) that should not fire in practice.
        const firstPath = livePaths[0];
        if (firstPath === undefined) {
          this.needsCatchUp.delete(docId);
          continue;
        }
        const liveEntry = this.index.get(firstPath);
        if (liveEntry === undefined || liveEntry.deleted === true) {
          // The path became a tombstone since liveByDocId was built. Prune.
          this.needsCatchUp.delete(docId);
          continue;
        }
        // Drain if stamps are now equal (the doc has been fully caught up already).
        const syncedStamp = await this.engineState.getSyncedStamp(docId);
        if (stampsEqual(liveEntry.stamp, syncedStamp)) {
          this.needsCatchUp.delete(docId);
        }
        // If stamps differ, leave the docId in the set — it still needs catch-up work.
      }
    }

    return [...byDocId.values()];
  }

  /**
   * Attach the catch-up set through a bounded-concurrency pool (≤ `concurrency`
   * attach operations in flight). For each item: materialize the doc (docStore
   * snapshot → {@link CrdtProvider.loadDoc}, else {@link CrdtProvider.createDoc}),
   * `transport.attach`, await `synced()`, then record the doc's ACTUAL synced
   * content as the new synced stamp for that doc. A doc whose `synced()` REJECTS
   * (e.g. transport closed) is isolated: its synced stamp is left unchanged and the
   * run continues.
   *
   * STALE-SNAPSHOT LATCH (0b-3 fix). `item.entry` was snapshotted back in
   * {@link computeCatchUpSet}, BEFORE the `synced()` + `reconcileLocal` awaits. If a
   * newer index bump (a relayed remote bump, or the local conflict-resolution bump)
   * lands during that window, `item.entry.stamp` is STALE — recording it would latch
   * the synced stamp at an intermediate hash that never re-advances to the converged
   * tree stamp, so {@link SyncEngine.pendingDocs} reports the doc pending FOREVER on
   * the AUTHORING device (the peer settles fine → the asymmetric latch). And because
   * concurrent passes each carry their OWN snapshot, a pass with an older snapshot can
   * win the LAST write. We therefore record what was ACTUALLY synced: the hash of the
   * doc's CURRENT text after attach+synced+reconcileLocal — the doc is the single
   * source of truth for "the content this device has exchanged with the relay", and
   * every concurrent pass reads the SAME current text, so the last writer is benign.
   *
   * DIRTY HANDLING (NEW-5): attach + synced + reconcile IS the durable reconcile, so
   * `clearDirty` retires this device's re-push obligation — but ONLY when the synced
   * content matches the CURRENT index/tree content. OFFLINE-EDIT SAFETY: if a fresh
   * local edit landed during the window, the doc text won't match the index stamp (the
   * edit isn't on the relay and the index hasn't been bumped to it yet); clearing dirty
   * then would falsely mark an UNPUSHED edit as synced and it would never be re-pushed
   * → silent DATA LOSS. So we leave it dirty (and `pendingDocs`'s disk-hash clause keeps
   * it pending), and the next cycle pushes it. Tasks that introduce a separate durable-
   * push step revisit this.
   *
   * OFFLINE (Task 13b Part 2): catch-up is an ONLINE activity. While the transport
   * is offline it is a no-op — an offline `attach` would hang on `synced()`, and a
   * premature `setSyncedStamp` would falsely clear an unpushed offline edit. The
   * reconnect path re-runs catch-up via the index `observe` + `waitConverged` loop.
   *
   * @returns the docIds freshly attached this pass (reused docs are not re-counted).
   */
  async runCatchUp(openDocIds: Set<DocId>, scope?: CatchUpScope): Promise<DocId[]> {
    if (this.transport.status() === "offline") return [];

    const items = await this.computeCatchUpSet(openDocIds, scope);
    const attached: DocId[] = [];

    await this.runPool(items, async (item) => {
      const docId = item.entry.docId;

      // REUSE the engine's canonical attached doc when present. Re-materializing a
      // fresh doc each pass would orphan the live one (losing its content + outbound
      // subscription) — the Part-2 bug that stranded offline-origin edits behind a
      // freshly-created empty doc. A reused doc auto-resyncs via the transport.
      //
      // ALSO skip if a concurrent pass already RESERVED this docId (attaching.has):
      // two concurrent runCatchUp passes can both see getAttached→undefined before
      // either awaits materialize; the reservation (added SYNCHRONOUSLY before the
      // first await) ensures only one proceeds — preventing the zombie double-attach.
      const existing = this.getAttached?.(docId);
      let doc: CrdtDoc;
      // The live handle for this doc — needed to await its relay ACK below. For a fresh
      // attach it is the handle we just minted; for a reused doc it is the one the manager
      // recorded when it first attached (or the engine surfaces from its handle map). We
      // NEVER re-attach to obtain one (that would violate the no-re-attach contract).
      let handle: AttachedDoc | undefined;
      if (existing === undefined && !this.attaching.has(docId)) {
        // RESERVE synchronously — MUST happen before any await in this branch.
        this.attaching.add(docId);
        try {
          doc = await this.materialize(docId);
          // Seam (Task 13): wire outbound + record the doc as attached BEFORE the
          // transport attach. `transport.attach` may deliver remote content in its
          // initial state-vector exchange SYNCHRONOUSLY; subscribing outbound first
          // guarantees that content reaches disk (no missed first update).
          this.onAttached?.(doc);
          handle = this.transport.attach(doc);
          // Record the handle so a LATER pass that reuses this doc can await its ack.
          this.handles.set(docId, handle);
          // Seam (Task 7): surface the handle to the engine for stop()-time detach.
          this.onAttachedHandle?.(docId, handle);
          attached.push(docId);
          try {
            await handle.synced();
          } catch {
            // synced() rejected (e.g. transport closed): leave synced stamp / dirty
            // untouched and continue. The next catch-up re-selects this doc.
            return;
          }
        } finally {
          // Clear reservation whether attach succeeded or failed.
          this.attaching.delete(docId);
        }
      } else if (existing !== undefined) {
        doc = existing;
        // Reused doc: recover its existing handle WITHOUT re-attaching.
        handle = this.handles.get(docId) ?? this.getAttachedHandle?.(docId);
      } else {
        // attaching.has(docId) — a concurrent pass is handling this doc; skip.
        return;
      }

      // Seed/merge this device's local-origin content into the now-attached, synced
      // doc (adopt-pending materialization). No-op unless the doc is dirty.
      await this.reconcileLocal?.(doc);

      // RELAY-ACK GATE (0b-3 Fix 5) — close the crash-window data-loss class. The synced
      // stamp / dirty flag previously advanced on the strength of `synced()` ALONE, which
      // only proves the FIRST handshake — NOT that the post-`reconcileLocal` push reached
      // the relay. A crash in that window persists `dirty:[]` + advanced-stamp to disk while
      // the relay never got the content → on restart the device thinks it is synced and
      // never re-pushes → SILENT LOSS. So before retiring the obligation we require the
      // transport's per-doc relay ACK (the relay RECEIVED+MERGED our queued updates — NOT
      // fsync-grade durability, which would need a server change; see AttachedDoc.acked).
      //
      // BOUNDED + OFFLINE-SAFE: catch-up already early-returned when offline, so we only
      // await `acked()` online, and even then race it against a timeout (and its own
      // close/offline rejection). If the ack does NOT land — timeout, reject, or the
      // transport drops mid-wait — we DO NOT advance the synced stamp and DO NOT clear
      // dirty: the doc stays dirty and re-pushes next cycle (`pendingDocs` keeps it pending,
      // `waitConverged` re-runs catch-up, a genuinely stuck ack surfaces as a VISIBLE
      // non-settle — never silent loss). A missing handle (no seam wired it) means we cannot
      // prove receipt, so we treat it as not-acked and skip retiring — fail safe.
      const acked = handle !== undefined && (await this.awaitAckBounded(handle));
      if (!acked) {
        // Stage 3: ack timed out or dropped — this doc was SELECTED but exits without
        // proving equality. Enqueue it in needsCatchUp so a later pass retries it even
        // if no index key change re-selects it. (Risk #2 in the cross-model review.)
        // S6a: use enqueueNeedsCatchUp to fire onBackstopWork only when genuinely new (anti-spin).
        this.enqueueNeedsCatchUp(docId);
        return;
      }

      // Record what was ACTUALLY synced — the hash of the doc's CURRENT text — NOT the
      // stale `item.entry.stamp` snapshot (see the STALE-SNAPSHOT LATCH note above).
      // The doc's text is ground truth for the content this device exchanged with the
      // relay; reading it here re-advances the synced stamp to the converged content
      // even when a newer bump landed during the attach window, and is race-stable
      // across concurrent passes (all read the same current text).
      const syncedHash = await sha256OfText(doc.getText());
      const syncedStamp = makeStamp(syncedHash, this.deviceId);
      await this.engineState.setSyncedStamp(docId, syncedStamp);

      // Retire the re-push obligation ONLY when the synced content matches the CURRENT
      // index entry — i.e. there is nothing left to push. If an UNPUSHED local edit
      // landed during the window (doc text ≠ index stamp), keep dirty so the edit is
      // re-pushed next cycle; clearing it would be silent data loss (offline-edit
      // safety). Re-read the entry NOW (not the snapshot) so a mid-window bump counts.
      // SECOND GATE: both this stamp-equality check AND the relay ACK above must pass.
      const currentStamp = this.index.get(item.path)?.stamp ?? null;
      if (stampsEqual(syncedStamp, currentStamp)) {
        // The pushed content is relay-acked AND matches the current index entry (nothing newer
        // pending) — advance the doc's ACKED/recovery base to it BEFORE retiring the dirty
        // obligation (0b-3 crash-window no-loss). Same gate as clearDirty, so an UNPUSHED edit
        // that landed during the window (doc ≠ index) does NOT advance the acked base.
        await this.onPushAcked?.(doc);
        await this.engineState.clearDirty(docId);
        // Stage 3: DRAIN needsCatchUp — this pass proved equality (convergence proof). The doc
        // is fully caught up; no need to force-retry it. (S4+ will also check this on scoped
        // passes that select the docId via the needsCatchUp backstop.)
        this.needsCatchUp.delete(docId);
      } else {
        // Stage 3: stamps NOT equal after setSyncedStamp — an unpushed local edit landed
        // mid-window (doc was selected but did not prove equality). ENQUEUE into needsCatchUp
        // so a later pass retries it under S4+ scoping (where an unrelated index change might
        // not re-select it). Under S3 full passes pendingDocs + the observe loop re-run
        // catch-up anyway — this enqueue is backstop bookkeeping for S4+ completeness and does
        // NOT change S3 convergence (full passes still do the real work).
        // (Cross-model review item 3; spec S3 backstop completeness.)
        // S6a: use enqueueNeedsCatchUp to fire onBackstopWork only when genuinely new (anti-spin).
        this.enqueueNeedsCatchUp(docId);
      }
    });

    return attached;
  }

  /**
   * CLEAN-SETTLE the symmetric clean-disjoint-3-way-merge `pendingDocs` latch (0b-3 Fix 6 /
   * Root 1C). After a clean disjoint 3-way merge the CONTENT converges PERFECTLY on both
   * devices — the attached doc's text hash == the on-disk content hash == the index entry's
   * stamp hash — yet both devices can latch `pendingDocs=1` FOREVER because the per-doc synced
   * stamp is stuck at an INTERMEDIATE merge hash the tree stamp never returns to.
   *
   * WHY {@link runCatchUp}'s ack-gated synced-advance does NOT clear it: over the real async
   * relay the doc reaches the final merged content via REMOTE updates that land AFTER the local
   * push was acked at an intermediate hash. The catch-up worker's `setSyncedStamp` is only
   * reached when the per-doc relay ACK resolves within the SAME pass — but a doc that converged
   * via remote updates re-arms no fresh local-push ack, so the bounded `acked()` wait does not
   * re-resolve and the worker early-returns BEFORE re-stamping. The synced stamp stays latched
   * at the intermediate hash even though doc==disk==index all agree on the converged hash.
   *
   * THE SETTLE: for every live entry whose attached doc text hash == on-disk content hash ==
   * index entry stamp hash AND the BEST-EFFORT no-unacked-changes gate passes (its `acked()`
   * resolves within the bound), advance ONLY the per-doc synced stamp to that agreed hash. The
   * triple-equality gate is the primary safety: it fires solely for content all three authorities
   * already agree on (the genuinely converged content) — never for an UNPUSHED local edit (doc
   * text ≠ index stamp ⇒ skipped). The no-unacked gate is best-effort, NOT a proof of receipt: it
   * can resolve VACUOUSLY when nothing was queued for the doc this round (the Hocuspocus adapter
   * resolves `acked()` immediately when `hasUnsyncedChanges` is false). The REAL safety floor for
   * an un-relayed edit is that this settle advances ONLY `syncedStamp` and NEVER clears dirty (see
   * SEPARATION OF CONCERNS below): even a vacuously-settled un-relayed edit stays dirty + pending
   * + re-pushed by `runCatchUp`, so a false synced-stamp can never strand un-relayed content.
   *
   * SEPARATION OF CONCERNS (do NOT conflate with the crash-fix ack discipline):
   * - DOES NOT clear dirty — retiring the push obligation still requires the specific dirty-push
   *   ack in {@link runCatchUp} (the no-loss crash-window discipline). Clean-settle only fixes the
   *   SYNCED-STAMP latch (the false-pending), not the push obligation.
   * - DOES NOT advance the ACKED/recovery base — that stays ack-driven via `onPushAcked`. Here we
   *   touch the synced stamp (the convergence-reporting stamp) ONLY.
   * - LOOP-SAFE / READ-ONLY w.r.t. the index/inbox/blobs maps: it reads the index + doc text +
   *   on-disk hash and writes ONLY the per-doc engine `syncedStamp`. It NEVER re-attaches, never
   *   pushes, never mutates the index — so being re-run by {@link SyncEngine.waitConverged} / the
   *   index-observe chain after the doc converges (even for a REUSED already-attached doc) cannot
   *   relay or loop. Idempotent: once synced == the agreed hash a re-run no-ops.
   *
   * OFFLINE: a no-op while the transport is offline (mirrors {@link runCatchUp}) — an offline
   * `acked()` stays pending, and a settle there could mark content the relay has not yet
   * exchanged as synced.
   *
   * REUSE-ONLY: it settles ONLY docs the engine already has ATTACHED ({@link getAttached}) — it
   * never materializes or attaches a doc. A doc that is not attached has no converged in-memory
   * text to read; `runCatchUp` owns bringing it up, and its tree-stamp inequality keeps it pending
   * until then.
   *
   * Takes no open-set argument: unlike {@link runCatchUp}'s selection, the settle gate is pure
   * content-equality (doc==disk==index), so openness is irrelevant.
   */
  async settleCleanDocs(scope?: CatchUpScope): Promise<void> {
    if (this.transport.status() === "offline") return;
    if (this.getAttached === undefined || this.diskHashOf === undefined) {
      // Stage 3: when seams are missing, drain any remoteUpdatedSinceSettle docIds as
      // non-actionable (settle cannot run without the seams; don't let the set grow unbounded).
      this.remoteUpdatedSinceSettle.clear();
      return;
    }

    if (scope === undefined) {
      // ── FULL PATH (scope undefined) — byte-for-byte identical to pre-S6b ────────────────────
      //
      // Stage 3: track which docIds from remoteUpdatedSinceSettle this pass visits and settles or
      // confirms non-actionable. We collect live docIds from the main loop; after the loop, any
      // remoteUpdatedSinceSettle docId NOT in the live index is non-actionable and drained.
      const liveDocIds = new Set<DocId>();

      for (const [path, entry] of this.index.liveEntries()) {
        const docId = entry.docId;
        liveDocIds.add(docId);

        // Already settled to the index stamp ⇒ nothing to do (idempotent skip).
        const synced = await this.engineState.getSyncedStamp(docId);
        if (stampsEqual(synced, entry.stamp)) {
          // Stage 3: DRAIN — doc is already settled (syncedStamp == index stamp).
          // Drain from both remoteUpdatedSinceSettle and needsCatchUp (proven equality in state).
          this.remoteUpdatedSinceSettle.delete(docId);
          this.needsCatchUp.delete(docId);
          continue;
        }

        // REUSE-ONLY: an attached, converged doc is the in-memory source of the agreed text.
        const doc = this.getAttached(docId);
        if (doc === undefined) {
          // Stage 3: doc not attached — non-actionable for settle. Drain from remoteUpdatedSinceSettle.
          this.remoteUpdatedSinceSettle.delete(docId);
          continue;
        }

        // TRIPLE-EQUALITY GATE: doc text hash == on-disk hash == index entry stamp hash. Skip
        // unless ALL THREE agree — an UNPUSHED local edit (doc ≠ index) or a disk that still
        // lags (disk ≠ index) is NOT converged and must keep owing its catch-up/ingest work.
        const docStamp = makeStamp(await sha256OfText(doc.getText()), this.deviceId);
        if (!stampsEqual(docStamp, entry.stamp)) continue;
        const diskHash = await this.diskHashOf(docId);
        const diskStamp = diskHash === null ? null : makeStamp(diskHash, this.deviceId);
        if (!stampsEqual(diskStamp, entry.stamp)) continue;

        // NO-UNACKED-CHANGES GATE (BEST-EFFORT): a reused doc's handle is the one the manager
        // recorded (or the engine surfaces); without a handle we cannot even attempt the check, so
        // skip (fail safe — the next round retries once a handle exists). `acked()` resolving within
        // the bound is the "no unacked changes" signal, but it is NOT a proof the relay RECEIVED this
        // content: the Hocuspocus adapter resolves `acked()` IMMEDIATELY when `hasUnsyncedChanges`
        // is false, so for a doc that queued nothing this round it resolves VACUOUSLY. The real
        // safety floor is NOT this gate — it is that clean-settle advances ONLY `syncedStamp` and
        // NEVER clears dirty (see the SEPARATION OF CONCERNS in the docstring): a vacuously-settled
        // un-relayed edit stays dirty + pending in `runCatchUp` and is re-pushed regardless.
        const handle = this.handles.get(docId) ?? this.getAttachedHandle?.(docId);
        if (handle === undefined) continue;
        const acked = await this.awaitAckBounded(handle);
        if (!acked) continue;

        // CLEAN-SETTLE: advance ONLY the synced stamp to the agreed hash. Re-read the index entry
        // NOW so a stamp that bumped during the awaits above is honoured (don't settle to a stamp
        // the index has since moved past). Do NOT clear dirty / advance the acked base (see above).
        const current = this.index.get(path)?.stamp ?? null;
        if (stampsEqual(docStamp, current)) {
          await this.engineState.setSyncedStamp(docId, docStamp);
          // Stage 3: DRAIN — clean-settle just advanced the synced stamp to match the index stamp.
          this.remoteUpdatedSinceSettle.delete(docId);
          this.needsCatchUp.delete(docId);
        }
      }

      // Stage 3: drain any set entries whose docId is NOT in the live index (deleted, tombstoned,
      // or never had a live entry). Keeps both sets bounded across the full lifecycle.
      for (const docId of this.remoteUpdatedSinceSettle) {
        if (!liveDocIds.has(docId)) {
          this.remoteUpdatedSinceSettle.delete(docId);
        }
      }
      for (const docId of this.needsCatchUp) {
        if (!liveDocIds.has(docId)) {
          this.needsCatchUp.delete(docId);
        }
      }
    } else {
      // ── SCOPED PATH (S6b) — iterate only workset docIds ─────────────────────────────────────
      //
      // Correctness invariant:
      //   scope.workset ⊇ {open ∪ dirty ∪ needsCatchUp ∪ changed-paths ∪ divergence ∪ remoteUpdated}
      // guaranteed by buildWorksetWithMaps in engine.ts. Any docId that needs settling is in
      // the workset: it is either a changed path, in needsCatchUp, in remoteUpdatedSinceSettle,
      // or is openDocId-bound (via openDocIds union). Active-bound docs are always in openDocIds
      // (hence always in the workset) and are visited via the triple-equality gate — they skip
      // until their disk catches up (disk hash != index stamp), which is correct.
      for (const docId of scope.workset) {
        const livePaths = scope.liveByDocId.get(docId);
        if (livePaths === undefined) {
          // This docId has no live entry at all — drain it from backstop sets (non-actionable).
          this.remoteUpdatedSinceSettle.delete(docId);
          // Do NOT drain needsCatchUp here: a docId with no live entry but in needsCatchUp
          // should be pruned by the post-loop sweep below (using the FULL liveByDocId), so we
          // get consistent liveness resolution. Draining here (based on the workset subset) is
          // correct but redundant since the sweep covers it.
          continue;
        }

        for (const path of livePaths) {
          const entry = this.index.get(path);
          // Defensive guard: entry may have been tombstoned since liveByDocId was built.
          if (entry === undefined || entry.deleted === true) continue;

          // Already settled to the index stamp ⇒ nothing to do (idempotent skip).
          const synced = await this.engineState.getSyncedStamp(docId);
          if (stampsEqual(synced, entry.stamp)) {
            // DRAIN — doc is already settled (syncedStamp == index stamp).
            this.remoteUpdatedSinceSettle.delete(docId);
            this.needsCatchUp.delete(docId);
            continue;
          }

          // REUSE-ONLY: an attached, converged doc is the in-memory source of the agreed text.
          const doc = this.getAttached(docId);
          if (doc === undefined) {
            // Doc not attached — non-actionable for settle. Drain from remoteUpdatedSinceSettle.
            this.remoteUpdatedSinceSettle.delete(docId);
            continue;
          }

          // TRIPLE-EQUALITY GATE: identical per-entry logic to the full path.
          const docStamp = makeStamp(await sha256OfText(doc.getText()), this.deviceId);
          if (!stampsEqual(docStamp, entry.stamp)) continue;
          const diskHash = await this.diskHashOf(docId);
          const diskStamp = diskHash === null ? null : makeStamp(diskHash, this.deviceId);
          if (!stampsEqual(diskStamp, entry.stamp)) continue;

          // NO-UNACKED-CHANGES GATE (BEST-EFFORT): same as full path.
          const handle = this.handles.get(docId) ?? this.getAttachedHandle?.(docId);
          if (handle === undefined) continue;
          const acked = await this.awaitAckBounded(handle);
          if (!acked) continue;

          // CLEAN-SETTLE: advance ONLY the synced stamp to the agreed hash.
          const current = this.index.get(path)?.stamp ?? null;
          if (stampsEqual(docStamp, current)) {
            await this.engineState.setSyncedStamp(docId, docStamp);
            // DRAIN — clean-settle just advanced the synced stamp to match the index stamp.
            this.remoteUpdatedSinceSettle.delete(docId);
            this.needsCatchUp.delete(docId);
          }
        }
      }

      // POST-LOOP PRUNE — resolve liveness against the FULL scope.liveByDocId (NOT the scoped
      // workset subset). A docId outside the workset but with a live entry must NOT be pruned,
      // even though the scoped loop did not visit it. This mirrors how S4b's computeCatchUpSet
      // resolves the same "prune against full liveByDocId, not the scoped subset" problem.
      //
      // A docId is live iff scope.liveByDocId.has(docId). If it has no live entry it is
      // deleted/tombstoned → prune from both backstop sets to keep them bounded.
      for (const docId of this.remoteUpdatedSinceSettle) {
        if (!scope.liveByDocId.has(docId)) {
          this.remoteUpdatedSinceSettle.delete(docId);
        }
      }
      for (const docId of this.needsCatchUp) {
        if (!scope.liveByDocId.has(docId)) {
          this.needsCatchUp.delete(docId);
        }
      }
    }
  }

  /**
   * Await a doc's relay ACK with a BOUND. Resolves `true` only if the transport confirms the
   * relay RECEIVED+MERGED this doc's queued updates within {@link ACK_TIMEOUT_MS}; resolves
   * `false` on timeout, on `acked()` rejection (close/detach), or if the transport goes offline
   * mid-wait. A `false` result tells the caller to LEAVE the doc dirty + its synced stamp
   * unadvanced — the no-loss invariant: an unconfirmed push is never retired.
   *
   * The timer is always cleared (no dangling handle keeps the process alive), and the rejected
   * `acked()` is swallowed so a close-time rejection never surfaces as an unhandled rejection.
   */
  private async awaitAckBounded(handle: AttachedDoc): Promise<boolean> {
    // Fail fast if the transport already went offline (the ack would hang till timeout).
    if (this.transport.status() === "offline") return false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, this.ackTimeoutMs);
    });
    const ack = handle
      .acked()
      .then(() => true)
      .catch(() => false);

    try {
      return await Promise.race([ack, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** docStore snapshot → loadDoc; otherwise a fresh doc via createDoc. */
  private async materialize(id: DocId): Promise<CrdtDoc> {
    const snapshot = await this.docStore.load(id);
    return snapshot === null ? this.provider.createDoc(id) : this.provider.loadDoc(id, snapshot);
  }

  /**
   * A minimal async worker pool over `items`, capping in-flight `worker` calls at
   * `this.concurrency`. N workers pull from a shared cursor until the array is
   * drained; no new deps. Order of completion is unspecified.
   */
  private async runPool(
    items: CatchUpItem[],
    worker: (item: CatchUpItem) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(this.concurrency, items.length));

    const run = async (): Promise<void> => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        const item = items[i];
        if (item === undefined) return;
        await worker(item);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => run()));
  }
}
