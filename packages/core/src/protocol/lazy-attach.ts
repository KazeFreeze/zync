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
}

/** One path/entry pair selected for catch-up. */
interface CatchUpItem {
  path: VaultPath;
  entry: TreeEntry;
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
  }

  /**
   * The set of docs to attach right now, as `{ path, entry }` pairs:
   *   { open } ∪ { tree stamp ≠ synced stamp } ∪ { dirty (re-push on connect) }.
   * De-duplicated by `docId`. Selection is PURE INEQUALITY — never ordering.
   */
  async computeCatchUpSet(openDocIds: Set<DocId>): Promise<CatchUpItem[]> {
    const byDocId = new Map<DocId, CatchUpItem>();
    const pathByDocId = new Map<DocId, CatchUpItem>();

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
      }
    }

    // Union in dirty docs (re-push on connect), mapping each back to its index path.
    // A dirty docId with no live index entry is skipped (nothing to re-push against).
    for (const dirtyId of await this.engineState.listDirty()) {
      if (byDocId.has(dirtyId)) continue;
      const item = pathByDocId.get(dirtyId);
      if (item !== undefined) byDocId.set(dirtyId, item);
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
  async runCatchUp(openDocIds: Set<DocId>): Promise<DocId[]> {
    if (this.transport.status() === "offline") return [];

    const items = await this.computeCatchUpSet(openDocIds);
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
      if (!acked) return;

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
  async settleCleanDocs(): Promise<void> {
    if (this.transport.status() === "offline") return;
    if (this.getAttached === undefined || this.diskHashOf === undefined) return;

    for (const [path, entry] of this.index.liveEntries()) {
      const docId = entry.docId;

      // REUSE-ONLY: an attached, converged doc is the in-memory source of the agreed text.
      const doc = this.getAttached(docId);
      if (doc === undefined) continue;

      // Already settled to the index stamp ⇒ nothing to do (idempotent skip).
      const synced = await this.engineState.getSyncedStamp(docId);
      if (stampsEqual(synced, entry.stamp)) continue;

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
