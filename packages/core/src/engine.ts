import type {
  VaultPort,
  CrdtProvider,
  TransportPort,
  BlobStorePort,
  DocStorePort,
  ClockPort,
  IdentityPort,
  EngineStateStore,
  AttachedDoc,
  CrdtDoc,
  DocId,
  Sha256,
  Unsubscribe,
  VaultEvent,
  VaultPath,
} from "./ports.js";
import { INDEX_DOC_ID } from "./ports.js";
import type { Route } from "./classify/classify.js";
import { classify, type Caps } from "./classify/classify.js";
import { EchoLedger } from "./bridge/echo.js";
import { BaseStore } from "./bridge/base.js";
import { FileAuthority } from "./bridge/fsm.js";
import { IngestPipeline } from "./bridge/ingest.js";
import { OutboundPipeline } from "./bridge/outbound.js";
import { recordTombstone } from "./bridge/tombstone.js";
import { applyRename } from "./bridge/rename.js";
import { IndexDoc } from "./protocol/index-doc.js";
import { LazyAttachManager } from "./protocol/lazy-attach.js";
import { runStructuralReconcile } from "./protocol/structural-reconcile.js";
import { applyBootstrap } from "./protocol/bootstrap.js";
import { supervisedImport } from "./conflicts/supervised-import.js";
import { orphanSweep, type OrphanMeta } from "./protocol/orphan-sweep.js";
import { makeStamp, stampsEqual } from "./protocol/stamp.js";
import { BlobEngine, type BlobFetchPolicy, type BlobManifestEntry } from "./blobs/blob-engine.js";
import { Inbox } from "./conflicts/inbox.js";
import { writeConflictArtifact } from "./conflicts/artifact.js";
import { sha256OfBytes, sha256OfText } from "./hash.js";
import { diffToEdits, merge3 } from "./bridge/merge.js";

export interface EnginePorts {
  vault: VaultPort;
  crdt: CrdtProvider;
  transport: TransportPort;
  blobs: BlobStorePort;
  docStore: DocStorePort;
  clock: ClockPort;
  identity: IdentityPort;
  engineState: EngineStateStore;
}

export interface EngineConfig {
  configDir: string;
  maxProseBytes: number;
  substrate?: string;
  blobPolicy?: BlobFetchPolicy;
  /** Index-stamp bump debounce (ms). Default 1500; tests pass 0 (immediate, microtask). */
  stampDebounceMs?: number;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const DEFAULT_DEBOUNCE_MS = 1500;

/** A pending debounced bump: its settle promise is tracked by {@link SyncEngine.whenIdle}. */
interface PendingBump {
  timer: ReturnType<typeof setTimeout> | null;
  docId: DocId;
  route: Route;
  sha: Sha256;
  /** Resolves once the bump has been written to the index. */
  done: Promise<void>;
  resolve: () => void;
}

/**
 * Composition facade (0b-2 Task 13). Wires every behind-port domain module into a
 * working `start()`/`stop()`: the always-attached index doc, ONE shared
 * {@link EchoLedger} across ingest + outbound + blob (the cross-pipeline
 * loop-breaker), lazy attach/catch-up, bootstrap, and the vault/index event
 * subscriptions.
 *
 * DETERMINISM SEAM: every fire-and-forget reconcile is registered in `#inflight`
 * via {@link track}. {@link whenIdle} drains that set (flushing pending debounced
 * bumps first), and {@link waitConverged} loops `whenIdle → runCatchUp → whenIdle`
 * until {@link pendingDocs} is empty — so tests never poll on `setTimeout`.
 *
 * Stays yjs-free: it composes PORTS + the pure domain modules only.
 */
export class SyncEngine {
  // ── exposed for assertions ──────────────────────────────────────────────
  index!: IndexDoc;
  inbox!: Inbox;

  // ── shared loop-breaker + per-note base store ───────────────────────────
  readonly echo = new EchoLedger();
  readonly base: BaseStore;

  private readonly ports: EnginePorts;
  private readonly config: EngineConfig;
  private readonly substrate: string;
  private readonly caps: Caps;
  private readonly debounceMs: number;

  // ── start()-time state ──────────────────────────────────────────────────
  private indexDoc: CrdtDoc | null = null;
  private indexAttached: AttachedDoc | null = null;
  private ingest!: IngestPipeline;
  private outbound!: OutboundPipeline;
  private lazyAttach!: LazyAttachManager;
  private blobEngine!: BlobEngine;

  // ── subscriptions to unwind on stop() ───────────────────────────────────
  private vaultUnsub: Unsubscribe | null = null;
  private indexUnsub: Unsubscribe | null = null;
  private blobUnsub: Unsubscribe | null = null;

  // ── per-note bookkeeping ────────────────────────────────────────────────
  private readonly attached = new Map<DocId, CrdtDoc>();
  private readonly attachedUnsubs = new Map<DocId, Unsubscribe>();
  /**
   * Tracks every `AttachedDoc` handle returned by `transport.attach(doc)` for a
   * NOTE doc (i.e. not the index doc). `stop()` calls `.detach()` on each so the
   * bus peer + `doc.onUpdate` subscription are unregistered, closing the M4 leak.
   */
  private readonly attachedHandles = new Map<DocId, AttachedDoc>();
  private readonly authorities = new Map<VaultPath, FileAuthority>();
  private docSeq = 0;

  // ── deterministic quiescence ────────────────────────────────────────────
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly pendingBumps = new Map<VaultPath, PendingBump>();

  constructor(ports: EnginePorts, config: EngineConfig) {
    this.ports = ports;
    this.config = config;
    this.substrate = config.substrate ?? "yjs";
    this.caps = { maxProseBytes: config.maxProseBytes, configDir: config.configDir };
    this.debounceMs = config.stampDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.base = new BaseStore(ports.vault, config.configDir);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // start / stop
  // ──────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const { crdt, transport, identity } = this.ports;
    const deviceId = identity.deviceId();

    // 1. Index doc — ALWAYS attached. Its tree/inbox/blobs maps relay over the transport.
    const indexDoc = crdt.createDoc(INDEX_DOC_ID);
    this.indexDoc = indexDoc;
    this.index = new IndexDoc(indexDoc.getMap("tree"), deviceId);
    this.inbox = new Inbox(indexDoc.getMap("inbox"));
    this.indexAttached = transport.attach(indexDoc);
    // Await the FIRST index sync when the transport is reachable ("connected" or
    // "connecting" — the production socket is still handshaking when status is
    // "connecting", but it will reach a synced state). Skip it for "offline" and
    // "unauthorized": per the offline contract `synced()` stays PENDING during a
    // partition and would hang forever, so we let bootstrap seed locally instead.
    // On reconnect the index doc auto-resyncs and the index-observe subscription
    // drives convergence without a re-attach.
    const conn = transport.status();
    if (conn === "connected" || conn === "connecting") await this.indexAttached.synced();

    // 2. Blob engine over the index `blobs` map.
    this.blobEngine = new BlobEngine({
      manifest: indexDoc.getMap<BlobManifestEntry>("blobs"),
      blobStore: this.ports.blobs,
      vault: this.ports.vault,
      echo: this.echo,
      identity,
      policy: this.config.blobPolicy ?? "lazy",
    });
    this.blobUnsub = this.blobEngine.start();

    // 3. Ingest pipeline (file → CRDT) — SHARED echo (cross-pipeline loop-breaker).
    this.ingest = new IngestPipeline({
      vault: this.ports.vault,
      index: this.index,
      echo: this.echo,
      base: this.base,
      engineState: this.ports.engineState,
      caps: this.caps,
      substrate: this.substrate,
      getAttachedDoc: (docId) => this.attached.get(docId),
      getAuthority: (path) => this.authorityFor(path),
      newDocId: () => this.mintDocId(),
      bumpStamp: (path, docId, route, sha) => {
        this.scheduleBump(path, docId, route, sha);
      },
      emitConflict: (path, losingText) => {
        this.track(this.emitConflict(path, losingText));
      },
    });

    // 4. Outbound pipeline (CRDT → file) — path resolved via the index reverse-lookup.
    this.outbound = new OutboundPipeline({
      vault: this.ports.vault,
      base: this.base,
      engineState: this.ports.engineState,
      echo: this.echo,
      identity,
      substrate: this.substrate,
      pathOf: (docId) => this.pathOf(docId),
    });

    // 5. Lazy-attach manager — onAttached wires outbound + records the attached doc.
    this.lazyAttach = new LazyAttachManager({
      index: this.index,
      engineState: this.ports.engineState,
      transport,
      provider: crdt,
      docStore: this.ports.docStore,
      getAttached: (docId) => this.attached.get(docId),
      onAttached: (doc) => {
        this.bindOutbound(doc);
      },
      onAttachedHandle: (docId, handle) => {
        this.attachedHandles.set(docId, handle);
      },
      reconcileLocal: (doc) => this.reconcileDirtyDoc(doc),
    });

    // 6. Bootstrap: seed local prose that has no index entry yet; then sweep orphans.
    await this.bootstrap();

    // 7. Subscribe vault events (each handler tracked so whenIdle awaits it).
    this.vaultUnsub = this.ports.vault.onEvent((e) => {
      this.onVaultEvent(e);
    });

    // 8. Subscribe index changes → pull peers' bumped docs via catch-up, then
    //    reconcile the inbound index against the vault (inbound tombstone →
    //    vault.remove). Structural reconcile runs AFTER catch-up so a doc the same
    //    index change attaches is materialized before we judge its disk state.
    this.indexUnsub = this.index.observe(() => {
      this.track(
        this.lazyAttach.runCatchUp(this.openDocIds()).then(() => this.structuralReconcile()),
      );
    });

    // 9. Initial catch-up so an adopting device pulls everything the index already
    //    lists, then an initial structural reconcile so a tombstone already present
    //    at adopt time is applied.
    this.track(
      this.lazyAttach.runCatchUp(this.openDocIds()).then(() => this.structuralReconcile()),
    );
  }

  async stop(): Promise<void> {
    // Settle anything still in flight so stop() leaves no open work.
    await this.whenIdle();

    this.vaultUnsub?.();
    this.indexUnsub?.();
    this.blobUnsub?.();
    this.vaultUnsub = null;
    this.indexUnsub = null;
    this.blobUnsub = null;

    for (const pending of this.pendingBumps.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.resolve();
    }
    this.pendingBumps.clear();

    // Detach every note-doc transport handle BEFORE destroying the docs (M4): the
    // handles were previously dropped, leaving bus peers + onUpdate subscriptions
    // alive after stop(). Idempotent — the transport's detachAttachment is a no-op
    // if the attachment is already gone (e.g. transport.close() ran first).
    for (const handle of this.attachedHandles.values()) handle.detach();
    this.attachedHandles.clear();

    for (const unsub of this.attachedUnsubs.values()) unsub();
    this.attachedUnsubs.clear();
    for (const doc of this.attached.values()) doc.destroy();
    this.attached.clear();

    this.indexAttached?.detach();
    this.indexAttached = null;
    this.indexDoc?.destroy();
    this.indexDoc = null;

    // The transport is shared/owned by the caller; we detach our docs but do NOT
    // close it here (multiple engines/tests share one bus).
  }

  // ──────────────────────────────────────────────────────────────────────────
  // observability / test seams
  // ──────────────────────────────────────────────────────────────────────────

  /** Resolves when NO reconcile is in flight (drains the tracked set; flushes bumps first). */
  async whenIdle(): Promise<void> {
    this.flushBumps();
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /**
   * Docs whose tree stamp ≠ synced stamp, unioned with the dirty set, unioned with
   * UNAPPLIED DELETES (0b-2 Task 1): a tombstoned entry whose path STILL has a local
   * file is pending until structural reconcile removes it — otherwise
   * {@link waitConverged} could pass while a delete is unapplied (false quiescence).
   */
  async pendingDocs(): Promise<DocId[]> {
    const pending = new Set<DocId>();
    for (const [path, entry] of this.index.liveEntries()) {
      const synced = await this.ports.engineState.getSyncedStamp(entry.docId);
      if (!stampsEqual(entry.stamp, synced)) pending.add(entry.docId);
      // UNMATERIALIZED CONTENT (0b-2 Task 2, C3): a LIVE entry whose ON-DISK content
      // hash ≠ the entry's stamp hash has not reached disk yet. This catches the
      // resurrection-RECEIVER race: a device with no local file gets the now-live
      // index entry and the resurrected note-doc content as TWO independent CRDT
      // docs; if the note update is applied while the index is still tombstoned,
      // outbound skips the write — without this check the device would falsely
      // report quiescence with an EMPTY/STALE file. Pending here keeps
      // `waitConverged` looping until structural reconcile materializes the content.
      const bytes = await this.ports.vault.read(path);
      const diskHash =
        bytes === null
          ? null
          : makeStamp(await sha256OfBytes(bytes), this.ports.identity.deviceId());
      if (!stampsEqual(entry.stamp, diskHash)) pending.add(entry.docId);
    }
    for (const dirty of await this.ports.engineState.listDirty()) pending.add(dirty);
    for (const [path, entry] of this.index.entries()) {
      if (entry.deleted !== true) continue;
      if ((await this.ports.vault.read(path)) !== null) pending.add(entry.docId);
    }
    return [...pending];
  }

  /**
   * Drive to quiescence: loop `whenIdle → runCatchUp → whenIdle` until
   * {@link pendingDocs} is empty. BOUNDED — throws if it cannot settle, so a real
   * stuck convergence surfaces as a failure rather than a hang.
   */
  async waitConverged(): Promise<void> {
    const MAX_ROUNDS = 50;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await this.whenIdle();
      if ((await this.pendingDocs()).length === 0) return;
      // Catch-up THEN structural reconcile (mirrors the index-observe chain): the
      // reconcile's materialization step drives a now-live resurrected entry's
      // content to disk, which the disk-aware pendingDocs check waits on.
      await this.lazyAttach.runCatchUp(this.openDocIds());
      await this.structuralReconcile();
      await this.whenIdle();
      if ((await this.pendingDocs()).length === 0) return;
    }
    const stuck = await this.pendingDocs();
    throw new Error(
      `waitConverged: did not settle after ${String(MAX_ROUNDS)} rounds: ${stuck.join(", ")}`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // internals
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Wire the OUTBOUND pipeline for a freshly-attached note doc: on every
   * `"remote"`-origin update, TRACK the reconcile so {@link whenIdle} waits for the
   * file to reach disk (the fix for the fire-and-forget flakiness). Idempotent — a
   * doc re-selected by catch-up keeps its single subscription.
   */
  private bindOutbound(doc: CrdtDoc): void {
    this.attached.set(doc.id, doc);
    if (this.attachedUnsubs.has(doc.id)) return;
    const unsub = doc.onUpdate((_update, origin) => {
      if (origin === "remote") this.track(this.outbound.onRemoteUpdate(doc));
    });
    this.attachedUnsubs.set(doc.id, unsub);
  }

  /**
   * Push this device's local-origin content into a freshly-attached (or reused) +
   * synced note doc (adopt-pending materialization, 0b-2 Task 13b Part 2). A note
   * CREATED after start — or edited while its doc was not attached — lives only on
   * disk + base + index stamp; without seeding it into the CRDT a peer would sync an
   * EMPTY doc (false quiescence). NO-OP unless the doc is dirty (this device owes a
   * push), so it runs at most once per dirty cycle (catch-up `clearDirty`s right
   * after).
   *
   * EMPTY post-sync CRDT ⇒ no peer holds this doc ⇒ THIS device is the origin: seed
   * the disk content wholesale. A non-empty CRDT already carries shared history, so
   * `merge3` against the base applies only the delta — never re-inserting a duplicate
   * copy (the doubled-content landmine).
   *
   * LOOP DISCIPLINE: writes ONLY the CRDT (`applyEdits`), the doc store, the base
   * store, and — echo-guarded — the file. It NEVER writes the index/inbox/blobs maps,
   * so being driven from the remote-facing catch-up path cannot ping-pong. The index
   * stamp was already set by the local ingest that marked the doc dirty.
   */
  private async reconcileDirtyDoc(doc: CrdtDoc): Promise<void> {
    const docId = doc.id;
    if (!(await this.ports.engineState.listDirty()).includes(docId)) return;

    const path = this.pathOf(docId);
    if (path === undefined) return;
    const bytes = await this.ports.vault.read(path);
    if (bytes === null) return; // gone — the delete/tombstone path owns this
    const diskText = decode(bytes);
    const crdtText = doc.getText();

    let merged: string;
    if (crdtText === "") {
      merged = diskText;
    } else {
      const baseRec = await this.base.load(docId);
      merged = merge3(baseRec?.baseText ?? "", diskText, crdtText).merged;
    }

    if (merged !== crdtText) doc.applyEdits(diffToEdits(crdtText, merged), "local-bridge");
    const mergedHash = await sha256OfText(merged);
    // base BEFORE file (torn-pair rule — mirrors OutboundPipeline.onRemoteUpdate):
    // a crash between the two leaves the base in a recoverable state.
    await this.base.save(docId, {
      baseText: merged,
      fileHash: mergedHash,
      crdtToken: doc.encodeStateVector(),
      substrate: this.substrate,
    });
    if (merged !== diskText) {
      // echo.recordWrite IMMEDIATELY precedes vault.writeAtomic, ALWAYS.
      this.echo.recordWrite(path, mergedHash);
      await this.ports.vault.writeAtomic(path, utf8(merged));
    }
    await this.ports.docStore.save(docId, doc.encodeSnapshot());
  }

  /**
   * Reconcile the inbound index against the local vault (0b-2 Tasks 1 + 2):
   *
   * - C1 (delete): an inbound tombstone whose path STILL has a local file matching
   *   the tombstone's content hash becomes a `vault.remove`. That removal fires a
   *   "delete" event → `onDelete`, which early-returns because the entry is ALREADY
   *   tombstoned — so the removal does NOT re-tombstone or loop (no echo plumbing
   *   needed).
   * - C3 (resurrect): a CONTESTED tombstone (disk hash ≠ stamp hash — a concurrent
   *   edit after delete-time) re-lists the entry LIVE at the disk content hash and
   *   `markDirty`s the doc so catch-up pushes the resurrected content; an inbox
   *   notice is surfaced (mapped to the `resurrected` inbox kind). Idempotent: once
   *   LIVE, a re-run skips it.
   */
  private async structuralReconcile(): Promise<void> {
    await runStructuralReconcile({
      index: this.index,
      vault: this.ports.vault,
      localHashOf: async (path) => {
        const bytes = await this.ports.vault.read(path);
        return bytes === null ? null : await sha256OfBytes(bytes);
      },
      markDirty: (docId) => this.ports.engineState.markDirty(docId),
      onInboxNotice: (notice) => {
        this.inbox.add({
          id: `resurrected:${notice.path}:${notice.docId}`,
          kind: "resurrected",
          path: notice.path,
          docId: notice.docId,
          detail: `${notice.path} was edited after a delete, so it was restored.`,
        });
      },
    });

    // Materialize any LIVE entry whose attached doc carries content the local disk
    // does not yet reflect. This closes a cross-doc ORDERING race in the C3
    // resurrection: a receiving device (no local file — its resurrect pass is a
    // no-op) gets the note-doc's resurrected content AND the index's now-live entry
    // as TWO independent CRDT docs. If the note update is applied while the index is
    // still tombstoned, outbound's `pathOf` finds no live path and skips the disk
    // write — yet catch-up still records the synced stamp, so the device would
    // report quiescence with an EMPTY file. Re-driving the (idempotent, echo-guarded)
    // outbound reconcile once the entry is live guarantees the content reaches disk.
    await this.materializeLiveDiskContent();

    // Recover any concurrent-create loser orphaned by the index LWW (C2, D5). Run from
    // the structural pass — NOT only at bootstrap — so a collision that surfaces AFTER
    // sync (both devices seeded the path offline, then healed) recovers. Idempotent +
    // loop-safe: a recovered orphan becomes bound, so the next sweep skips it.
    await this.runOrphanSweep();
  }

  /**
   * Materialize a LIVE entry's CANONICAL content to disk when the file lags behind.
   * For each live entry with an attached doc, re-run the outbound reconcile (CRDT →
   * file) ONLY when:
   *   - the on-disk content hash ≠ the entry's stamp hash (disk is stale/missing), AND
   *   - the attached doc's text hash === the entry's stamp hash (the CRDT has
   *     CONVERGED to the indexed content — so we write the agreed-upon canonical
   *     state, never a transient mid-conflict doc state).
   *
   * This narrow gate is what lets it fix the C3 resurrection-receiver race (a device
   * with no local file gets a now-live entry + its note content as two independent
   * docs; if the note update arrived while the index was still tombstoned, outbound
   * skipped the write) WITHOUT perturbing an in-flight same-line conflict whose doc
   * has not yet settled to the stamp.
   *
   * Idempotent + loop-safe: outbound writes only when disk differs and is
   * echo-guarded — it NEVER touches the index/inbox, so it cannot relay or loop.
   */
  private async materializeLiveDiskContent(): Promise<void> {
    const deviceId = this.ports.identity.deviceId();
    for (const [path, entry] of this.index.liveEntries()) {
      const doc = this.attached.get(entry.docId);
      if (doc === undefined) continue;

      const docStamp = makeStamp(await sha256OfText(doc.getText()), deviceId);
      if (!stampsEqual(docStamp, entry.stamp)) continue; // CRDT not yet at the indexed content.

      const bytes = await this.ports.vault.read(path);
      const diskStamp = bytes === null ? null : makeStamp(await sha256OfBytes(bytes), deviceId);
      if (stampsEqual(diskStamp, entry.stamp)) continue; // disk already canonical.

      await this.outbound.onRemoteUpdate(doc);
    }
  }

  /** Add a fire-and-forget promise to the inflight set; auto-remove on settle. */
  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => {
      this.inflight.delete(p);
    });
  }

  private openDocIds(): Set<DocId> {
    const ids = new Set<DocId>();
    for (const [path, authority] of this.authorities) {
      if (authority.state !== "active-bound") continue;
      const entry = this.index.get(path);
      if (entry !== undefined) ids.add(entry.docId);
    }
    return ids;
  }

  private authorityFor(path: VaultPath): FileAuthority {
    let a = this.authorities.get(path);
    if (a === undefined) {
      a = new FileAuthority(path);
      this.authorities.set(path, a);
    }
    return a;
  }

  /** Unique per device: `${deviceId}-${clock.now()}-${seq}`. */
  private mintDocId(): DocId {
    const deviceId = this.ports.identity.deviceId();
    return `${deviceId}-${String(this.ports.clock.now())}-${String(this.docSeq++)}` as DocId;
  }

  /** Reverse-lookup a docId → its live vault path via the index. */
  private pathOf(docId: DocId): VaultPath | undefined {
    for (const [path, entry] of this.index.liveEntries()) {
      if (entry.docId === docId) return path;
    }
    return undefined;
  }

  // ── debounced index-stamp bump ──────────────────────────────────────────

  /**
   * Schedule (or coalesce) a debounced index-stamp bump for `path`. The pending
   * bump's `done` promise is TRACKED so {@link whenIdle} waits for it. With
   * `debounceMs === 0` the bump fires on a microtask (still tracked, still
   * deterministic); otherwise it fires after the debounce window.
   */
  private scheduleBump(path: VaultPath, docId: DocId, route: Route, sha: Sha256): void {
    const existing = this.pendingBumps.get(path);
    if (existing !== undefined) {
      // Coalesce: latest content wins; the existing tracked `done` still gates idle.
      existing.docId = docId;
      existing.route = route;
      existing.sha = sha;
      return;
    }

    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const pending: PendingBump = { timer: null, docId, route, sha, done, resolve };
    this.pendingBumps.set(path, pending);
    this.track(done);

    if (this.debounceMs <= 0) {
      queueMicrotask(() => {
        this.firePending(path);
      });
    } else {
      pending.timer = setTimeout(() => {
        this.firePending(path);
      }, this.debounceMs);
    }
  }

  private firePending(path: VaultPath): void {
    const pending = this.pendingBumps.get(path);
    if (pending === undefined) return;
    this.pendingBumps.delete(path);
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.index.setStamp(path, pending.docId, pending.route, pending.sha);
    pending.resolve();
  }

  /** Force every pending debounced bump to fire NOW (used by whenIdle). */
  flushBumps(): void {
    for (const path of [...this.pendingBumps.keys()]) this.firePending(path);
  }

  // ── conflict artifact ────────────────────────────────────────────────────

  /**
   * Write the losing side as a conflict artifact + surface an inbox entry. The `ts`
   * token is `sha(losing).slice(0,8)` (DETERMINISTIC — never wall-clock) so two
   * devices that both detect the conflict compute the same artifact path.
   */
  private async emitConflict(path: VaultPath, losingText: string): Promise<void> {
    const deviceId = this.ports.identity.deviceId();
    const ts = (await sha256OfText(losingText)).slice(0, 8);
    const artifactPath = await writeConflictArtifact(
      { vault: this.ports.vault, echo: this.echo },
      path,
      losingText,
      deviceId,
      ts,
    );
    this.inbox.add({
      id: `conflict:${path}:${ts}`,
      kind: "conflict",
      path,
      artifactPath,
      detail: `Conflicting local edit to ${path} kept as ${artifactPath}.`,
    });
  }

  // ── bootstrap ────────────────────────────────────────────────────────────

  /**
   * Fetch the SERVER text for a bound docId during bootstrap's supervised-import
   * (M1), WITHOUT wiring outbound (the caller adopts server / parks local in the
   * correct order itself, so a premature outbound write must not overwrite the path
   * before the local copy is parked).
   *
   * - docStore snapshot present ⇒ {@link CrdtProvider.loadDoc} + read text, then
   *   DESTROY the throwaway doc (it is not transport-attached). The initial catch-up
   *   materializes + attaches a fresh doc for this id. Returns `doc: null`.
   * - no snapshot ⇒ {@link CrdtProvider.createDoc} + `transport.attach` + await
   *   `synced()` so the server content arrives, read text, and RETURN the now-attached
   *   doc so the caller can register it (`bindOutbound`) as the canonical attached doc
   *   after the adopt. Recorded in {@link attached} so the initial catch-up reuses it.
   */
  private async materializeServerText(
    docId: DocId,
  ): Promise<{ text: string; doc: CrdtDoc | null }> {
    const snapshot = await this.ports.docStore.load(docId);
    if (snapshot !== null) {
      const doc = this.ports.crdt.loadDoc(docId, snapshot);
      const text = doc.getText();
      doc.destroy();
      return { text, doc: null };
    }
    const doc = this.ports.crdt.createDoc(docId);
    this.attached.set(docId, doc);
    const handle = this.ports.transport.attach(doc);
    // Track this handle so stop() can detach it (M4).
    this.attachedHandles.set(docId, handle);
    await handle.synced();
    return { text: doc.getText(), doc };
  }

  /**
   * Genesis/bootstrap (design §9.4). EVERY local prose file — bound OR unbound — is
   * routed through {@link applyBootstrap}, then acted on by its decision:
   *
   * - `seed` (no server doc): mint/keep a docId, seed the content into a fresh CRDT
   *   doc (snapshot saved so lazy-attach materializes THIS content, not an empty
   *   doc), and bump the index so peers learn of the path. `applyBootstrap` already
   *   saved the adopt-pending base + `markDirty`.
   * - `adopt-server` + `needsAttach:false` (BYTE-IDENTICAL local — the M2 zero-attach
   *   landmine guard): `applyBootstrap` already saved base + synced stamp; nothing
   *   else to do, NO note attach (no doubled docId, no wasted network).
   * - `adopt-server` + `needsAttach:true` (server exists, no byte-identical local):
   *   leave it for the initial catch-up to materialize the server content.
   * - `supervised-import` (the M1 fix — server doc exists, no base, local DIVERGES):
   *   materialize the server text, ADOPT it as the live note, PARK the divergent
   *   local copy as a deterministic conflict artifact, and surface ONE inbox entry.
   *   NEVER a silent overwrite, NEVER a merge3 against an empty base.
   * - `converge` / `none`: let catch-up handle it (per `needsAttach`).
   *
   * Routing bound paths here is what stops a 2nd device joining with a divergent
   * local copy from having its content silently overwritten (M1) and restores the
   * zero-attach identical-adopt property (M2). Finishes with an orphan sweep.
   */
  private async bootstrap(): Promise<void> {
    const deviceId = this.ports.identity.deviceId();
    for (const { path } of await this.ports.vault.list()) {
      const bytes = await this.ports.vault.read(path);
      if (bytes === null) continue;

      const existing = this.index.get(path);
      // Sticky route: a bound path keeps its index route; an unbound path classifies fresh.
      const route = existing?.type ?? classify(path, bytes, this.caps).route;
      if (route !== "crdt-prose") continue;

      const text = decode(bytes);
      const treeStamp = existing?.stamp ?? null;
      const docId = existing?.docId ?? this.mintDocId();
      const result = await applyBootstrap(
        {
          base: this.base,
          engineState: this.ports.engineState,
          baseExists: async (id) => (await this.base.load(id)) !== null,
          substrate: this.substrate,
        },
        { path, docId, localText: text, treeStamp, deviceId },
      );

      switch (result.decision) {
        case "seed": {
          // Seed the content into a fresh CRDT doc + persist a snapshot so lazy-attach
          // materializes THIS content. Then bump the index so peers learn of the path.
          // `applyBootstrap` already saved base + markDirty.
          const doc = this.ports.crdt.createDoc(docId);
          if (text !== "") doc.applyEdits(diffToEdits("", text), "local-bridge");
          // Create-metadata (Task 4, D3): stamp the doc with the path/author/ts of THIS
          // create BEFORE snapshotting, so it replicates with the doc. If two devices
          // each seed the same path with their OWN docId (offline concurrent-create),
          // the index LWW binds the path to one winner and the loser docId is orphaned;
          // the orphan sweep reads this meta to derive a DETERMINISTIC recovery path
          // every device agrees on (so the loser's content is recovered, never lost).
          const meta: OrphanMeta = {
            createdBy: deviceId,
            createdTs: String(this.ports.clock.now()),
            originalPath: path,
          };
          doc.getMap<OrphanMeta>("meta").set("create", meta);
          await this.ports.docStore.save(docId, doc.encodeSnapshot());
          doc.destroy();
          const sha = await sha256OfText(text);
          this.index.setStamp(path, docId, "crdt-prose", sha);
          break;
        }
        case "supervised-import": {
          // Server doc exists, no base, local DIVERGES (M1). Materialize the server
          // text WITHOUT wiring outbound (so it cannot write the path before we park
          // the local copy), then adopt server / park local / one inbox entry.
          const { text: serverText, doc } = await this.materializeServerText(docId);
          const ts = (await sha256OfText(text)).slice(0, 8);
          await supervisedImport(
            {
              vault: this.ports.vault,
              echo: this.echo,
              base: this.base,
              inbox: this.inbox,
              substrate: this.substrate,
            },
            { path, docId, localText: text, serverText, deviceId, ts },
          );
          // If the doc was attached through the transport (no docStore snapshot), it is
          // now the engine's CANONICAL attached doc: wire its outbound AFTER the adopt
          // (so the park-then-adopt order is not raced) so future remote updates reach
          // disk and the initial catch-up REUSES it (records the synced stamp) rather
          // than re-attaching.
          if (doc !== null) this.bindOutbound(doc);
          break;
        }
        // adopt-server, converge, none: `applyBootstrap` performed any no-attach side
        // effects (M2's zero-attach base+synced-stamp under adopt-server+!needsAttach);
        // the initial catch-up materializes server content when `needsAttach` is true.
        case "adopt-server":
        case "converge":
        case "none":
          break;
      }
    }

    // Orphan sweep: recover any docId in the doc-set not bound by a live tree entry.
    // (Also re-run from the structural pass so a collision that surfaces AFTER sync
    // recovers — see {@link runOrphanSweep}.)
    await this.runOrphanSweep();
  }

  /**
   * Recover concurrent-create losers (C2, design D3 + D5). An ORPHAN is a docId in
   * THIS device's docStore not bound by any LIVE tree entry — the byproduct of two
   * devices each seeding the SAME path with their OWN docId: the index `tree` LWW
   * binds the path to one winner, leaving the loser docId orphaned in the loser's
   * store. The sweep recovers each to a DETERMINISTIC `name (conflict, <createdBy>,
   * <createdTs>).md`, REUSING the orphan docId; the recovered content + index
   * binding then replicate to peers via normal sync.
   *
   * `orphanData` materializes the orphan from THIS device's local docStore snapshot:
   * only the OWNING device (which holds the snapshot) can recover it — by design.
   * A docId with no local snapshot returns `null` and is skipped (the owner recovers
   * it; the result then syncs here).
   *
   * LOOP-SAFETY (D2): driven from the remote-facing structural pass, but `recoverOrphan`
   * is idempotent + convergent — deterministic path, LWW re-set, dedup inbox id — and
   * once recovered the orphan is BOUND, so the next sweep skips it. The relay quiesces.
   */
  private async runOrphanSweep(): Promise<void> {
    const { crdt, docStore } = this.ports;
    await orphanSweep(
      {
        vault: this.ports.vault,
        echo: this.echo,
        index: this.index,
        inbox: this.inbox,
        base: this.base,
        substrate: this.substrate,
      },
      {
        index: this.index,
        docSet: await docStore.list(),
        orphanData: async (docId) => {
          // Only the device that OWNS the orphan (holds its snapshot) can materialize
          // it. No snapshot ⇒ not ours ⇒ skip; the owner recovers and it syncs here.
          const snap = await docStore.load(docId);
          if (snap === null) return null;
          const d = crdt.loadDoc(docId, snap);
          const text = d.getText();
          // Create-meta replicates with the seeded doc (D3). Absent meta ⇒ not a seeded
          // create (cannot be a concurrent-create loser) ⇒ skip.
          const meta = d.getMap<OrphanMeta>("meta").get("create");
          d.destroy();
          if (meta === undefined) return null;

          // DISCRIMINATE a concurrent-create LOSER from a merely-deleted doc. A loser's
          // original path is currently bound LIVE to a DIFFERENT (winner) docId — it
          // genuinely lost the create race. A deleted note's original path is tombstoned
          // (no live entry), so recovering it would wrongly resurrect a deleted file as a
          // conflict artifact. Only the former is recovered.
          const live = this.index.get(meta.originalPath);
          if (live === undefined || live.deleted === true || live.docId === docId) return null;

          return { text, type: "crdt-prose" as Route, meta };
        },
      },
    );
  }

  // ── vault events ───────────────────────────────────────────────────────────

  private onVaultEvent(e: VaultEvent): void {
    switch (e.type) {
      case "create":
      case "modify":
        this.track(this.onWrite(e.path));
        return;
      case "delete":
        this.track(this.onDelete(e.path));
        return;
      case "rename":
        this.onRename(e.oldPath, e.path);
        return;
    }
  }

  /**
   * A rename: re-key the index (old key tombstoned, new key live, SAME docId —
   * content continuity). IDEMPOTENT against the propagation echo: structural
   * reconcile's rename concern issues `vault.rename` on a peer, which fires a real
   * "rename" event back through here — but the index ALREADY reflects that move
   * (new live + old tombstoned, same docId), so re-applying it would only thrash
   * identical LWW writes. There is no content hash for a rename, so the EchoLedger
   * cannot suppress it; we suppress via INDEX STATE instead: if the move is already
   * applied, this is a no-op.
   */
  private onRename(oldPath: VaultPath, newPath: VaultPath): void {
    const from = this.index.get(oldPath);
    const to = this.index.get(newPath);
    // Move already reflected: new path live + old path tombstoned, SAME docId.
    if (
      from?.deleted === true &&
      to !== undefined &&
      to.deleted !== true &&
      to.docId === from.docId
    ) {
      return;
    }
    applyRename(this.index, oldPath, newPath);
  }

  /** A create/modify: route by sticky classify; prose → ingest, blob → blob engine. */
  private async onWrite(path: VaultPath): Promise<void> {
    const bytes = await this.ports.vault.read(path);
    if (bytes === null) return;

    const entry = this.index.get(path);
    const route = entry?.type ?? classify(path, bytes, this.caps).route;

    switch (route) {
      case "crdt-prose":
        await this.ingest.onVaultWrite(path);
        return;
      case "structured-blob":
      case "binary-blob":
        await this.blobEngine.onLocalBlobWrite(path, bytes);
        return;
      case "config":
      case "excluded":
        return;
    }
  }

  /** A delete: lay an edit-beats-delete tombstone keyed on the doc's last content hash. */
  private async onDelete(path: VaultPath): Promise<void> {
    const entry = this.index.get(path);
    if (entry === undefined || entry.deleted === true) return;
    const rec = await this.base.load(entry.docId);
    const sha = rec?.fileHash ?? (await sha256OfBytes(utf8("")));
    recordTombstone(this.index, path, entry.docId, entry.type, this.ports.identity.deviceId(), sha);
    this.echo.clear(path);
    // Clear any STRANDED dirty flag for the now-tombstoned doc. A dirty flag (set by
    // a prior local ingest) is a promise to re-push this device's content; a deleted
    // note has no live index path, so catch-up's `computeCatchUpSet` can never map
    // that dirty docId back to a path → it would never `clearDirty` it. Left dirty,
    // `pendingDocs()` (which unions the dirty set) reports the doc pending FOREVER →
    // `waitConverged` never settles. This bites a create-then-delete inside ONE
    // offline window (catch-up is a no-op offline, so the create's dirty flag is
    // still set when the delete tombstones the entry). Resurrection is unaffected: an
    // edit-beats-delete revival arrives as an inbound index change + note-doc content
    // and re-marks dirty through the normal ingest/reconcile path, not this stale flag.
    await this.ports.engineState.clearDirty(entry.docId);
  }
}
