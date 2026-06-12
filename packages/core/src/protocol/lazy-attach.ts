import type {
  AttachedDoc,
  CrdtDoc,
  CrdtProvider,
  DocId,
  DocStorePort,
  EngineStateStore,
  TransportPort,
  VaultPath,
} from "../ports.js";
import type { IndexDoc, TreeEntry } from "./index-doc.js";
import { stampsEqual } from "./stamp.js";

export interface LazyAttachDeps {
  index: IndexDoc;
  engineState: EngineStateStore;
  transport: TransportPort;
  provider: CrdtProvider;
  docStore: DocStorePort;
  /** Max attach operations in flight at once (default 6). */
  concurrency?: number;
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
   * OPTIONAL seam (Task 13b Part 2): push this device's local-origin content into a
   * freshly-attached (or reused) + synced doc — the adopt-pending materialization a
   * note created/edited while its doc was NOT attached needs to actually propagate.
   * The engine no-ops it unless the doc is dirty. Omitted in unit tests.
   */
  reconcileLocal?: (doc: CrdtDoc) => Promise<void>;
}

/** One path/entry pair selected for catch-up. */
interface CatchUpItem {
  path: VaultPath;
  entry: TreeEntry;
}

const DEFAULT_CONCURRENCY = 6;

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
  private readonly concurrency: number;
  private readonly onAttached: ((doc: CrdtDoc) => void) | undefined;
  private readonly onAttachedHandle: ((docId: DocId, handle: AttachedDoc) => void) | undefined;
  private readonly getAttached: ((docId: DocId) => CrdtDoc | undefined) | undefined;
  private readonly reconcileLocal: ((doc: CrdtDoc) => Promise<void>) | undefined;
  /**
   * DocIds for which a materialize+attach is currently in progress (reserved
   * BEFORE the first `await`). A concurrent pass that sees a docId here skips
   * it — preventing the double-attach race that would strand a zombie bus peer.
   */
  private readonly attaching = new Set<DocId>();

  constructor(deps: LazyAttachDeps) {
    this.index = deps.index;
    this.engineState = deps.engineState;
    this.transport = deps.transport;
    this.provider = deps.provider;
    this.docStore = deps.docStore;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.onAttached = deps.onAttached;
    this.onAttachedHandle = deps.onAttachedHandle;
    this.getAttached = deps.getAttached;
    this.reconcileLocal = deps.reconcileLocal;
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
   * `transport.attach`, await `synced()`, then record the tree stamp as the new
   * synced stamp for that doc. A doc whose `synced()` REJECTS (e.g. transport
   * closed) is isolated: its synced stamp is left unchanged and the run continues.
   *
   * DIRTY HANDLING (NEW-5): for this task, attach + synced + setSyncedStamp IS the
   * durable reconcile, so `clearDirty` is called once the synced stamp reflects the
   * tree stamp. Tasks that introduce a separate durable-push step revisit this.
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
          const handle = this.transport.attach(doc);
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
      } else {
        // attaching.has(docId) — a concurrent pass is handling this doc; skip.
        return;
      }

      // Seed/merge this device's local-origin content into the now-attached, synced
      // doc (adopt-pending materialization). No-op unless the doc is dirty.
      await this.reconcileLocal?.(doc);

      await this.engineState.setSyncedStamp(docId, item.entry.stamp);
      await this.engineState.clearDirty(docId);
    });

    return attached;
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
