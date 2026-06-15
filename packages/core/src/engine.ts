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
import { RenameTransaction } from "./bridge/rename-transaction.js";
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
import { makeStamp, stampHash, stampsEqual } from "./protocol/stamp.js";
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
  /**
   * Rename-transaction settle window (ms). After a rename the engine quarantines the
   * watcher's ASYNC `delete`/`modify` fallout for this long (RE-ARMED on each suppressed
   * event), then reconciles the on-disk invariant. MUST comfortably exceed the vault
   * watcher's coalesce delay (NodeFsVault: ~20ms) so a coalesced `delete(new)` is caught
   * inside the window. Default 60. (Determinism comes from RE-ARMING + reporting the open
   * transaction as pending — `waitConverged` loops until the timer fires; the value only
   * sets how long the bounded window is.)
   */
  renameSettleMs?: number;
  /**
   * Projector mode (0b-3 Part C): when `true`, the engine NEVER ingests a local file
   * write — {@link SyncEngine.onWrite} early-returns. Remote→disk outbound and
   * bootstrap-seed are unaffected. Rationale: a plaintext projector co-located on the
   * server is a READ-ONLY projection target; ingesting its own projected writes would
   * make it a SECOND write authority for every note (a sync loop + duplicate origin).
   */
  ingestDisabled?: boolean;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const DEFAULT_DEBOUNCE_MS = 1500;
/** Default rename-transaction settle window (ms) — see {@link EngineConfig.renameSettleMs}. */
const DEFAULT_RENAME_SETTLE_MS = 60;

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
  /**
   * Local rename TRANSACTION (0b-3, GPT-5.5 root cause): quarantines the ASYNC,
   * possibly-REORDERED watcher `delete`/`modify` fallout (incl. a `delete(new)`) a real
   * recursive `fs.watch` emits after a physical rename, then settles the on-disk
   * invariant. Supersedes the one-shot RenameEcho, which only modelled an ideal
   * synchronous `delete(old)+modify(new)`. The content-hash-keyed {@link EchoLedger}
   * cannot key a rename (no content change), so this is a SEPARATE mechanism.
   * See {@link RenameTransaction}.
   */
  private readonly renameTxn = new RenameTransaction();
  /**
   * Prior-pass divergent-rename signatures (`docId → sorted live paths`) for the STABILITY
   * GATE (see {@link StructuralReconcileDeps.confirmDivergence}). A divergence is resolved
   * only when the SAME signature was seen on the previous reconcile pass — so a TORN RENAME
   * (old key not yet tombstoned + new key live, a replication transient) dissolves before
   * the next pass and is never wrongly collapsed onto the old path.
   */
  private priorDivergence = new Map<DocId, string>();
  readonly base: BaseStore;

  private readonly ports: EnginePorts;
  private readonly config: EngineConfig;
  private readonly substrate: string;
  private readonly caps: Caps;
  private readonly debounceMs: number;
  private readonly renameSettleMs: number;

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
  /**
   * The single in-flight rename-transaction settle: a tracked, RE-ARMABLE timer (see
   * {@link scheduleRenameSettle}). Re-arming on each suppressed fallout event keeps the
   * quarantine open until the async/reordered watcher traffic has drained, then the
   * settle reconciles the on-disk invariant and closes every open transaction.
   */
  private renameSettle: {
    timer: ReturnType<typeof setTimeout> | null;
    done: Promise<void>;
    resolve: () => void;
  } | null = null;

  constructor(ports: EnginePorts, config: EngineConfig) {
    this.ports = ports;
    this.config = config;
    this.substrate = config.substrate ?? "yjs";
    this.caps = { maxProseBytes: config.maxProseBytes, configDir: config.configDir };
    this.debounceMs = config.stampDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.renameSettleMs = config.renameSettleMs ?? DEFAULT_RENAME_SETTLE_MS;
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
    if (conn === "connected" || conn === "connecting") {
      await this.indexAttached.synced();
    } else {
      // OFFLINE/UNAUTHORIZED: we deliberately do NOT await synced() (it stays PENDING
      // during a partition). Reconnect auto-resyncs via index-observe.
      this.swallowOfflineSynced(this.indexAttached);
    }

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
      onFirstCreate: (docId, path, text) => this.seedCreateMeta(docId, path, text),
      // Persist the edited CRDT snapshot for an already-attached doc so a restart reloads the
      // EDIT, not a stale pristine snapshot (0b-3 crash-window no-loss). The engine owns the
      // docStore, so it implements the seam.
      persistDocSnapshot: (docId, doc) => this.ports.docStore.save(docId, doc.encodeSnapshot()),
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
      deviceId,
      getAttached: (docId) => this.attached.get(docId),
      getAttachedHandle: (docId) => this.attachedHandles.get(docId),
      onAttached: (doc) => {
        this.bindOutbound(doc);
      },
      onAttachedHandle: (docId, handle) => {
        this.attachedHandles.set(docId, handle);
      },
      reconcileLocal: (doc) => this.reconcileDirtyDoc(doc),
      onPushAcked: (doc) => this.advanceAckedBase(doc),
      // Clean-settle (0b-3 Fix 6) reads the on-disk content hash for a doc's live path to
      // prove doc==disk==index agreement before re-advancing its synced stamp. READ-ONLY:
      // reads the vault + hashes; writes nothing.
      diskHashOf: (docId) => this.diskHashOf(docId),
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
        this.lazyAttach
          .runCatchUp(this.openDocIds())
          .then(() => this.structuralReconcile())
          // Clean-settle (0b-3 Fix 6) AFTER reconcile materialized disk: re-advance the synced
          // stamp of any doc that has fully converged (doc==disk==index) but whose synced stamp
          // is latched at an intermediate merge hash — the symmetric clean-3-way-merge latch.
          .then(() => this.lazyAttach.settleCleanDocs()),
      );
    });

    // 9. Initial catch-up so an adopting device pulls everything the index already
    //    lists, then an initial structural reconcile so a tombstone already present
    //    at adopt time is applied.
    this.track(
      this.lazyAttach
        .runCatchUp(this.openDocIds())
        .then(() => this.structuralReconcile())
        .then(() => this.lazyAttach.settleCleanDocs()),
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

    // Resolve any still-armed rename-transaction settle (the vault is now unsubscribed,
    // so no further fallout can re-arm it) so its tracked `done` gate never dangles.
    if (this.renameSettle !== null) {
      if (this.renameSettle.timer !== null) clearTimeout(this.renameSettle.timer);
      this.renameSettle.resolve();
      this.renameSettle = null;
    }
    // Close any open rename transactions so a torn-down engine leaves no path quarantine.
    this.renameTxn.closeAll();

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
    // UN-MATERIALIZED BLOB (0b-3 Fix 3): under EAGER policy, a manifest entry whose bytes are
    // NOT on this device's disk (file absent, OR on-disk sha ≠ the manifest sha) has not finished
    // syncing — the fire-and-forget `materialize` may still be in flight. Without this, an eager
    // follower's `waitConverged` declares quiescence while a manifest-advertised blob is still
    // missing from disk (the Fix-3 bug: blob reaches the server store but never lands on the
    // follower, yet pendingDocs reports 0). The blob manifest carries no DocId, so we add a stable DIAGNOSTIC token
    // (`blob:<path>`) — pendingDocs is consumed only by `.length`/`.join` (count + the
    // waitConverged stuck-dump), never resolved back to a doc, so the synthetic id names
    // the stuck blob in a failure dump. READ-ONLY: reads the manifest + vault, writes
    // NOTHING (loop discipline preserved — see pendingDocs' contract above).
    // POLICY-AWARE (0b-3 Fix): only an EAGER device's un-materialized blob is pending — its
    // fire-and-forget `materialize` is still in flight, so quiescence must wait for the bytes to
    // land. A LAZY device defers fetch until access BY DESIGN: it HAS the manifest and will fetch
    // on read, so an un-materialized advertised blob IS converged for it (counting it would hang
    // a lazy follower's waitConverged forever). READ-ONLY: reads manifest + vault, writes nothing.
    if ((this.config.blobPolicy ?? "lazy") === "eager") {
      for (const [path, entry] of this.blobManifestEntries()) {
        const bytes = await this.ports.vault.read(path);
        const diskSha = bytes === null ? null : await sha256OfBytes(bytes);
        if (diskSha !== entry.sha256) pending.add(`blob:${path}` as DocId);
      }
    }
    // OPEN RENAME TRANSACTION (0b-3): a rename whose bounded settle window has not yet
    // fired is in-flight — quiescence must wait so `waitConverged` does not declare
    // convergence while the watcher's async fallout is still quarantined (and before the
    // settle reconcile has proven the renamed file is on disk). The transaction carries a
    // DocId, so it names the in-flight rename in a stuck dump; once the settle fires it
    // closes and this clears. READ-ONLY: reads the transaction bookkeeping only.
    for (const txn of this.renameTxn.openTransactions()) pending.add(txn.docId);
    return [...pending];
  }

  /**
   * READ-ONLY snapshot of the blob manifest (the index `blobs` map), via the
   * {@link BlobEngine}. Used by {@link pendingDocs} to detect a manifest-advertised
   * blob whose bytes have not yet materialized onto this device's disk. PURE READ —
   * never mutates the manifest, so it is safe on the convergence loop.
   */
  blobManifestEntries(): [VaultPath, BlobManifestEntry][] {
    return this.blobEngine.manifestEntries();
  }

  /**
   * Drive to quiescence: loop `whenIdle → runCatchUp → whenIdle` until
   * {@link pendingDocs} is empty. BOUNDED — throws if it cannot settle, so a real
   * stuck convergence surfaces as a failure rather than a hang.
   */
  async waitConverged(): Promise<void> {
    const MAX_ROUNDS = 50;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      await this.drainEagerBlobs();
      await this.whenIdle();
      if ((await this.pendingDocs()).length === 0) return;
      // Catch-up THEN structural reconcile (mirrors the index-observe chain): the
      // reconcile's materialization step drives a now-live resurrected entry's
      // content to disk, which the disk-aware pendingDocs check waits on.
      await this.lazyAttach.runCatchUp(this.openDocIds());
      await this.structuralReconcile();
      // Clean-settle (0b-3 Fix 6): re-advance the synced stamp of any doc that has fully
      // converged (doc==disk==index) but whose synced stamp is latched at an intermediate
      // merge hash — the symmetric clean-3-way-merge latch the catch-up ack gate cannot clear
      // once the doc converged via remote updates. Runs AFTER reconcile so disk is materialized.
      await this.lazyAttach.settleCleanDocs();
      await this.drainEagerBlobs();
      await this.whenIdle();
      if ((await this.pendingDocs()).length === 0) return;
    }
    const stuck = await this.pendingDocs();
    throw new Error(
      `waitConverged: did not settle after ${String(MAX_ROUNDS)} rounds: ${stuck.join(", ")}`,
    );
  }

  /**
   * EAGER-BLOB CONVERGENCE DRIVER (0b-3 loop fix). The BlobEngine drives eager fetches via an
   * UNTRACKED fire-and-forget `void onManifestChange(...)` (manifest observe + the initial sweep),
   * so {@link whenIdle} — which only drains TRACKED inflight work — does not await it. Previously
   * the now-removed materialize feedback SPIN happened to keep re-driving it across waitConverged
   * rounds; with the spin gone, a single eager materialize could still be mid-flight (its
   * `crypto.subtle.digest` resolves on a macrotask) when waitConverged samples pendingDocs.
   *
   * So waitConverged AWAITS this deterministic, idempotent pass: for an EAGER engine, materialize
   * every manifest entry whose disk sha lags the manifest sha. LOOP-SAFE: {@link
   * BlobEngine.materialize} short-circuits when disk already matches (no fetch, no write) and is
   * echo-guarded; it writes ONLY `vault.writeAtomic` (never the manifest/index/inbox), so it
   * cannot re-publish or relay. Lazy is a no-op here (lazy defers fetch by design). A materialize
   * that rejects (corrupt blob / missing bytes) is swallowed — the still-mismatched disk keeps the
   * entry pending so waitConverged surfaces it as a non-settle rather than crashing the loop.
   */
  private async drainEagerBlobs(): Promise<void> {
    if ((this.config.blobPolicy ?? "lazy") !== "eager") return;
    for (const [path, entry] of this.blobManifestEntries()) {
      const bytes = await this.ports.vault.read(path);
      const diskSha = bytes === null ? null : await sha256OfBytes(bytes);
      if (diskSha === entry.sha256) continue; // already materialized — idempotent skip.
      try {
        await this.blobEngine.materialize(path);
      } catch {
        // Corrupt/missing bytes: leave disk as-is; pendingDocs keeps the entry pending.
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // editor / observability seam (0b-3 — the headless daemon control API)
  // ──────────────────────────────────────────────────────────────────────────
  //
  // READ-ONLY (or loop-safe-reuse) accessors over existing engine state. A daemon
  // hosting this engine needs the CANONICAL authority + attached-doc instances the
  // ingest pipeline uses (a SimulatedEditor and the /doc + /metrics endpoints must
  // operate on the SAME instances, not copies). None of these write the index, inbox,
  // or blobs maps from a remote-facing path — they reuse the already-loop-safe
  // {@link LazyAttachManager.runCatchUp} machinery.

  /**
   * The canonical {@link FileAuthority} for `path` — the SAME instance the ingest
   * pipeline resolves via its `getAuthority` dep. A daemon binds/unbinds this to
   * drive `active-bound` and reads `.state` for `fsmState`.
   */
  getAuthority(path: VaultPath): FileAuthority {
    return this.authorityFor(path);
  }

  /** The attached CRDT note doc for `path`, or `undefined` if not attached. */
  getAttachedDoc(path: VaultPath): CrdtDoc | undefined {
    if (this.indexDoc === null) {
      throw new Error("SyncEngine.getAttachedDoc: engine not started — call start() first");
    }
    const e = this.index.get(path);
    return e ? this.attached.get(e.docId) : undefined;
  }

  /**
   * Ensure the note doc for an OPEN `path` is attached + materialized, returning it.
   *
   * ORDERING CONTRACT: the caller MUST bind the editor FIRST (so the path's authority
   * is `active-bound`) — {@link openDocIds} only selects `active-bound` authorities, so
   * an unbound path would not be picked up by the catch-up below.
   *
   * Loop-safe: if the doc is already attached, returns it immediately; otherwise reuses
   * the existing initial-catch-up machinery ({@link LazyAttachManager.runCatchUp} over
   * the open set — exactly what `start()` step 9 does), which is loop-discipline-safe
   * (it never writes the index/inbox/blobs maps).
   *
   * OFFLINE FALLBACK: `runCatchUp` is an ONLINE activity (no-op while the transport is
   * offline). An editor must still open + edit a note offline (the whole point of local
   * editing), so when the doc is STILL unattached after catch-up AND the path has a live
   * index entry, do a LOCAL attach: materialize the doc (docStore snapshot → loadDoc, else
   * a fresh doc), `bindOutbound` it, attach it to the transport (offline-safe — the queued
   * attachment auto-syncs on reconnect; we do NOT await `synced()`), and run the dirty
   * reconcile so a note whose content lives only on disk+base (offline create) is seeded
   * into the CRDT. Still loop-safe: writes only the CRDT/docStore/base/echo-guarded file.
   */
  async ensureNoteAttached(path: VaultPath): Promise<CrdtDoc | undefined> {
    if (this.indexDoc === null) {
      throw new Error("SyncEngine.ensureNoteAttached: engine not started — call start() first");
    }
    const existing = this.getAttachedDoc(path);
    if (existing !== undefined) return existing;
    await this.lazyAttach.runCatchUp(this.openDocIds());
    const afterCatchUp = this.getAttachedDoc(path);
    if (afterCatchUp !== undefined) return afterCatchUp;

    // Offline (or otherwise un-attached) live entry: attach locally so the editor binds.
    const entry = this.index.get(path);
    if (entry === undefined || entry.deleted === true) return undefined;
    const docId = entry.docId;

    // DEFENSE-IN-DEPTH: if the doc was attached by a concurrent path (e.g. a catch-up
    // that raced this offline fallback), return it directly — do NOT re-attach.  This
    // guard mirrors the transport-level idempotency in HocuspocusTransport.attach; both
    // layers protect the two-file invariant the reviewer flagged.
    if (this.attachedHandles.has(docId)) {
      return this.getAttachedDoc(path);
    }

    const snapshot = await this.ports.docStore.load(docId);
    const doc =
      snapshot === null
        ? this.ports.crdt.createDoc(docId)
        : this.ports.crdt.loadDoc(docId, snapshot);
    // Wire outbound + record as the canonical attached doc BEFORE the transport attach
    // (so a synchronous initial state-vector exchange's content reaches disk).
    this.bindOutbound(doc);
    const handle = this.ports.transport.attach(doc);
    this.attachedHandles.set(docId, handle);
    // Do NOT await synced() — offline it stays pending; attach a no-op catch so the
    // stop()-time ClosedError reject is handled (no unhandled rejection on a daemon).
    this.swallowOfflineSynced(handle);
    // Seed this device's disk content into the now-attached doc (no-op unless dirty).
    await this.reconcileDirtyDoc(doc);
    return this.getAttachedDoc(path);
  }

  /** Count of attached NOTE docs (excludes the always-attached index doc). */
  attachedDocCount(): number {
    return this.attached.size;
  }

  /** Byte length of the index doc's full snapshot (0 before {@link start}). */
  indexSnapshotBytes(): number {
    return this.indexDoc?.encodeSnapshot().length ?? 0;
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
   * LOOP DISCIPLINE: writes the CRDT (`applyEdits`), the doc store, the base store, and —
   * echo-guarded — the file. It NEVER writes the inbox/blobs maps. It MAY re-assert the
   * recovered content into the INDEX via a gated `scheduleBump` on the crash-recovery path
   * (a SIGKILL+restart loses the in-memory ingest bump), but ONLY when the merged content's
   * hash differs from the index's current stamp — so it bumps at most once per stable
   * recovered hash and converges (the next pass finds index == content → no re-bump). That
   * re-assertion is a LOCAL-origin write of durable disk/base content, not a remote echo, so
   * being driven from the remote-facing catch-up path still cannot ping-pong. In steady state
   * the index stamp was already set by the local ingest that marked the doc dirty, so the gate
   * is a no-op. See the inline note on the `scheduleBump` call below.
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

    const baseRec = await this.base.load(docId);
    let merged: string;
    if (crdtText === "") {
      merged = diskText;
    } else {
      // CRASH-RECOVERY MERGE BASE (0b-3 crash-window no-loss). Merge against the last
      // RELAY-ACKED content (`ackedText`), NOT the WORKING base (`baseText`). A local edit
      // advanced the working base to the EDIT immediately at ingest, but that edit may not
      // have reached the relay. After a SIGKILL+restart with a pristine/stale reloaded CRDT
      // doc, merging against the working base gives `merge3(base=EDIT, disk=EDIT,
      // crdt=PRISTINE)` → only the CRDT changed → pristine wins → the disk edit is REVERTED
      // (the data loss). Merging against the ACKED base gives `merge3(acked=PRISTINE,
      // disk=EDIT, crdt=PRISTINE)` → the DISK EDIT is the winning change → it is recovered and
      // re-applied to the CRDT (which re-pushes it). Pre-0b-3 records default ackedText to
      // baseText, so steady-state behaviour is unchanged.
      merged = merge3(baseRec?.ackedText ?? "", diskText, crdtText).merged;
    }

    if (merged !== crdtText) doc.applyEdits(diffToEdits(crdtText, merged), "local-bridge");
    const mergedHash = await sha256OfText(merged);
    // base BEFORE file (torn-pair rule — mirrors OutboundPipeline.onRemoteUpdate):
    // a crash between the two leaves the base in a recoverable state. Advance the WORKING
    // base to the merged content, but CARRY FORWARD the acked/recovery base unchanged — this
    // reconcile pushes the content to the relay but does NOT itself confirm receipt (the
    // catch-up ack gate advances the acked base once the relay acks). Keeping the acked base
    // lagging is what preserves the disk edit if THIS push, too, is interrupted by a crash.
    await this.base.save(docId, {
      baseText: merged,
      fileHash: mergedHash,
      crdtToken: doc.encodeStateVector(),
      substrate: this.substrate,
      ackedText: baseRec?.ackedText ?? "",
      ackedHash: baseRec?.ackedHash ?? (await sha256OfText("")),
    });
    if (merged !== diskText) {
      // echo.recordWrite IMMEDIATELY precedes vault.writeAtomic, ALWAYS.
      this.echo.recordWrite(path, mergedHash);
      await this.ports.vault.writeAtomic(path, utf8(merged));
    }
    // Adopt-pending create-meta (0b-3 Fix 1): a note CREATED after start whose doc was
    // not attached at ingest time gets its create-meta when its doc is first materialized
    // here, so an adopt-pending after-start create is also recoverable by the orphan
    // sweep. Idempotent — `writeCreateMeta` no-ops when `meta.create` already exists.
    this.writeCreateMeta(doc, path);
    await this.ports.docStore.save(docId, doc.encodeSnapshot());

    // RE-ASSERT THE RECOVERED LOCAL CONTENT INTO THE INDEX (0b-3 crash-window no-loss). The
    // index stamp is normally bumped by the local ingest that marked the doc dirty — but a
    // SIGKILL+restart LOSES that in-memory bump (the index doc is relay-backed, not persisted),
    // so on reconnect the index re-syncs the relay's STALE (pre-edit) stamp. Without re-bumping,
    // the recovered edit reaches the doc/disk but the tree stamp stays stale → `pendingDocs`
    // reports the doc pending forever and peers never learn of the edit. So when the merged
    // (recovered) content differs from what the index currently records for this path, schedule
    // a LOCAL bump — the SAME seam ingest uses. This is a LOCAL-origin re-assertion of content
    // that lives on this device's durable disk+base, NOT a remote echo: it converges (a stable
    // recovered hash bumps once, peers materialize, the next pass finds index == content → no
    // re-bump), so it does not violate loop discipline.
    const indexStamp = this.index.get(path)?.stamp;
    if (indexStamp === undefined || stampHash(indexStamp) !== mergedHash) {
      this.scheduleBump(path, docId, "crdt-prose", mergedHash);
    }
  }

  /**
   * Advance the doc's ACKED/recovery base to its CURRENT text (0b-3 crash-window no-loss).
   * Invoked by the catch-up ack gate ONLY once the relay has confirmed receipt of the pushed
   * content AND that content matches the current index entry — so the doc's text is genuinely
   * relay-acked. Promotes the acked base (recovery anchor) to this content, so the NEXT
   * crash-recovery reconcile (after a future edit) merges against this now-acked content rather
   * than an unpushed edit. Persists the snapshot too (the durable record of the acked CRDT).
   *
   * PRESERVES THE WORKING BASE (`baseText`/`fileHash`): that field tracks the last content this
   * device RECONCILED TO DISK and is the anti-clobber anchor {@link materializeLiveDiskContent}
   * relies on (disk == working fileHash ⇒ disk is the content the doc moved past ⇒ safe to
   * write). Clobbering it to the doc text here would desync that guard from disk. We carry it
   * forward unchanged; only the acked/recovery base advances.
   *
   * LOOP-SAFE: writes only the base store + docStore (never the index/inbox/blobs maps), so it
   * is safe on the remote-facing catch-up path. NO-OP-friendly: if the acked base already equals
   * the doc text, the re-save is harmless (idempotent durable write).
   */
  private async advanceAckedBase(doc: CrdtDoc): Promise<void> {
    const docId = doc.id;
    const text = doc.getText();
    const hash = await sha256OfText(text);
    const prior = await this.base.load(docId);
    await this.base.save(docId, {
      // Carry the working base forward unchanged (the disk-reconcile anchor); on a first-ack
      // with no prior record, seed it from the now-acked content.
      baseText: prior?.baseText ?? text,
      fileHash: prior?.fileHash ?? hash,
      crdtToken: doc.encodeStateVector(),
      substrate: this.substrate,
      ackedText: text,
      ackedHash: hash,
    });
    await this.ports.docStore.save(docId, doc.encodeSnapshot());
  }

  /**
   * Write the {@link OrphanMeta} `create` entry into a NOTE doc's `meta` CRDT map —
   * the SAME shape the bootstrap `seed` path writes and {@link runOrphanSweep}'s
   * `orphanData` reads to recover a concurrent-create loser. IDEMPOTENT: a no-op when
   * `meta.create` already exists, so re-materialization (or a doc that was already
   * seeded at ingest) never re-stamps it with a different ts.
   *
   * `originalPath` is the path of THIS create — exactly what `orphanData` compares
   * against the index to discriminate a genuine LWW loser (its original path is bound
   * LIVE to a DIFFERENT docId) from a merely-deleted doc.
   *
   * LOOP DISCIPLINE: writes ONLY this note doc's `meta` map from the LOCAL ingest/
   * reconcile path — never the index/inbox/blobs maps, never from a remote-facing path.
   */
  private writeCreateMeta(doc: CrdtDoc, path: VaultPath): void {
    const metaMap = doc.getMap<OrphanMeta>("meta");
    if (metaMap.get("create") !== undefined) return;
    metaMap.set("create", {
      createdBy: this.ports.identity.deviceId(),
      createdTs: String(this.ports.clock.now()),
      originalPath: path,
    });
  }

  /**
   * Engine seam for {@link IngestDeps.onFirstCreate} (0b-3 Fix 1). A first-seen path's
   * AFTER-START create just minted `docId`; ingest persisted base + markDirty but — unlike
   * the bootstrap `seed` path — wrote neither the doc's `meta.create` nor a docStore
   * snapshot. Mirror the seed path here: materialize/seed a canonical doc for `docId`,
   * stamp its create-meta, and persist a snapshot. Both are PREREQUISITES for the orphan
   * sweep to recover this content if a concurrent same-path create wins the index LWW (the
   * sweep's `orphanData` needs a docStore snapshot AND `meta.create`). Done eagerly so an
   * OFFLINE loser (whose doc never attaches → never reconciles) is still recoverable.
   *
   * Reuses the engine's canonical attached doc when one already exists for `docId` (so we
   * never orphan a live doc); otherwise seeds a throwaway doc exactly as `bootstrap`'s
   * seed branch does. LOOP-SAFE: writes only the note doc's `meta` map + the docStore.
   */
  private async seedCreateMeta(docId: DocId, path: VaultPath, text: string): Promise<void> {
    const attached = this.attached.get(docId);
    if (attached !== undefined) {
      this.writeCreateMeta(attached, path);
      await this.ports.docStore.save(docId, attached.encodeSnapshot());
      return;
    }
    const doc = this.ports.crdt.createDoc(docId);
    if (text !== "") doc.applyEdits(diffToEdits("", text), "local-bridge");
    this.writeCreateMeta(doc, path);
    await this.ports.docStore.save(docId, doc.encodeSnapshot());
    doc.destroy();
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
    // STABILITY GATE bookkeeping (torn-rename race): record THIS pass's divergence
    // signatures while confirming against the PRIOR pass; swap in after the pass so the
    // NEXT pass can confirm. A divergence resolves only when seen on two consecutive passes.
    const currentDivergence = new Map<DocId, string>();
    const confirmDivergence = (docId: DocId, livePaths: VaultPath[]): boolean => {
      const sig = [...livePaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(" ");
      currentDivergence.set(docId, sig);
      return this.priorDivergence.get(docId) === sig;
    };
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
      confirmDivergence,
    });
    this.priorDivergence = currentDivergence;

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
   * CLOBBER HAZARD (0b-3 Fix 4, Finding D + crash-device revert half). The gate
   * "doc == stamp AND disk != stamp" is ALSO true when the on-disk file is a NEWER,
   * not-yet-ingested EXTERNAL edit (disk AHEAD of the doc/index). Writing the doc
   * there would CLOBBER the newer disk content with the stale converged text — silent
   * content loss (the `/sync/flush`-before-the-watcher-ingests race; and the
   * crash-device path where a relayed pristine snapshot flows into the doc, then
   * materialize reverts the still-edited disk back to pristine). So before writing we
   * disambiguate stale-BEHIND from newer-AHEAD via the base store:
   *   - no local file (bytes === null) → genuine resurrection/rename receiver → WRITE.
   *   - the doc is DIRTY → this device owes a push, so the on-disk content may be an UNPUSHED
   *     local edit (after a crash the recovered edit lives on disk + is dirty) → never clobber
   *     it → SKIP. This is the crash-device disambiguator: post-crash the WORKING base == the
   *     unpushed edit, so the hash compare below would mis-classify the disk edit as BEHIND;
   *     the dirty gate catches it first.
   *   - a file exists whose hash === the LAST-RECONCILED `base.fileHash` → it is the content
   *     the doc has since moved past (BEHIND) → SAFE to write.
   *   - otherwise (hash ≠ base.fileHash, or no base) → it is a newer un-ingested edit, or we
   *     cannot PROVE it is behind → SKIP. The ingest path will pick the disk edit up;
   *     `pendingDocs`'s disk-hash clause keeps `waitConverged` looping until ingest reconciles,
   *     so skipping cannot mask a loss as false convergence.
   * PRINCIPLE: when in doubt, SKIP — skipping is always safe (no data loss); clobbering
   * is not.
   *
   * Idempotent + loop-safe: outbound writes only when disk differs and is
   * echo-guarded — it NEVER touches the index/inbox, so it cannot relay or loop.
   */
  private async materializeLiveDiskContent(): Promise<void> {
    const deviceId = this.ports.identity.deviceId();
    // Load the dirty set ONCE before the loop (was re-read per live entry; behavior-identical).
    const dirty = await this.ports.engineState.listDirty();
    for (const [path, entry] of this.index.liveEntries()) {
      const doc = this.attached.get(entry.docId);
      if (doc === undefined) continue;

      const docStamp = makeStamp(await sha256OfText(doc.getText()), deviceId);
      if (!stampsEqual(docStamp, entry.stamp)) continue; // CRDT not yet at the indexed content.

      const bytes = await this.ports.vault.read(path);
      const diskStamp = bytes === null ? null : makeStamp(await sha256OfBytes(bytes), deviceId);
      if (stampsEqual(diskStamp, entry.stamp)) continue; // disk already canonical.

      // ANTI-CLOBBER GUARD: only write when the disk is genuinely BEHIND the converged
      // doc — never over a newer un-ingested edit, and never over a DIRTY doc's unpushed
      // edit (see CLOBBER HAZARD above).
      if (bytes !== null) {
        // DIRTY ⇒ this device owes a push; the disk may hold the unpushed (post-crash
        // recovered) edit. Never materialize over it — the dirty reconcile + re-push own it.
        if (dirty.includes(entry.docId)) continue;
        const base = await this.base.load(entry.docId);
        const diskHash = await sha256OfBytes(bytes);
        // disk ≠ last-reconciled working base ⇒ a newer un-ingested edit (or we cannot prove
        // it is behind: no base ⇒ `base?.fileHash` is undefined ⇒ never equal) ⇒ SKIP. Ingest
        // will reconcile it; pendingDocs keeps the loop alive.
        if (diskHash !== base?.fileHash) continue;
      }

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

  /**
   * Attach a no-op rejection handler to an offline `AttachedDoc.synced()` promise.
   *
   * Offline, `synced()` stays PENDING indefinitely. When `stop()` (or `detach()`) runs it
   * rejects with {@link ClosedError}. An unconsumed rejection that later rejects is an
   * UNHANDLED rejection in Node — which crashes a long-lived daemon. Attaching this no-op
   * catch immediately makes it a HANDLED rejection. One canonical location for the rationale.
   */
  private swallowOfflineSynced(handle: AttachedDoc): void {
    void handle.synced().catch(() => undefined);
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

  /**
   * The on-disk content hash for a docId's LIVE vault path, or `null` when no live path or no
   * local file exists. The {@link LazyAttachManager}'s clean-settle (0b-3 Fix 6) `diskHashOf`
   * seam — the manager has no vault port, so the engine supplies the hash here. READ-ONLY: reads
   * `vault.read` + hashes the bytes; writes NOTHING (loop discipline preserved).
   */
  private async diskHashOf(docId: DocId): Promise<Sha256 | null> {
    const path = this.pathOf(docId);
    if (path === undefined) return null;
    const bytes = await this.ports.vault.read(path);
    return bytes === null ? null : await sha256OfBytes(bytes);
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

  // ── rename-transaction settle ─────────────────────────────────────────────

  /**
   * Schedule (or RE-ARM) the rename-transaction settle. Called when a rename opens a
   * transaction AND each time a fallout event is quarantined, so the bounded window
   * always outlasts the watcher's async/reordered traffic. The settle's `done` promise
   * is TRACKED so {@link whenIdle} waits for it (and the open transaction is reported by
   * {@link pendingDocs}, so {@link waitConverged} keeps looping until it fires).
   *
   * RE-ARM: a fresh suppressed event clears the existing timer and starts a new window
   * but KEEPS the same `done` promise (the tracked gate stays the one inflight handle).
   */
  private scheduleRenameSettle(): void {
    if (this.renameSettle !== null) {
      // Already armed — restart the window so a late fallout event extends quarantine.
      if (this.renameSettle.timer !== null) clearTimeout(this.renameSettle.timer);
      this.renameSettle.timer = setTimeout(() => {
        this.fireRenameSettle();
      }, this.renameSettleMs);
      return;
    }
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => {
      this.fireRenameSettle();
    }, this.renameSettleMs);
    this.renameSettle = { timer, done, resolve };
    this.track(done);
  }

  private fireRenameSettle(): void {
    const settle = this.renameSettle;
    if (settle === null) return;
    if (settle.timer !== null) clearTimeout(settle.timer);
    this.renameSettle = null;
    // The settle reconcile is async; tie it to the tracked `done` so whenIdle waits for
    // the disk materialization, then resolve the gate.
    this.track(
      this.settleRenameTransactions().finally(() => {
        settle.resolve();
      }),
    );
  }

  /**
   * SETTLE every open rename transaction: reconcile the on-disk invariant, then close it
   * (lifting the quarantine). For each transaction the INVARIANT is:
   *   - `oldPath` ABSENT on disk — the physical move already removed it; the index
   *     tombstoned it in the re-key. (If a stranded old file somehow remains, the
   *     structural reconcile's stranded-old-file concern owns it — not this pass.)
   *   - `newPath` PRESENT on disk with the renamed content. If the watcher fallout (or a
   *     racing structural pass) removed it WHILE quarantined, the file is missing here —
   *     so MATERIALIZE it from the attached doc whose content is the renamed content.
   *
   * MATERIALIZE-FROM-DOC: when `newPath` has no local file but its docId is still LIVE at
   * `newPath`, re-drive the (idempotent, echo-guarded) outbound reconcile to write the
   * doc's content to disk. This is the safety net that recovers the renamed file the
   * residual bug stranded. NO-OP when the file is already present (the common case — the
   * quarantine kept the synthetic-rename'd file intact), so the existing synchronous-
   * rename tests are unperturbed.
   *
   * LOOP DISCIPLINE: writes NOTHING to the index/inbox/blobs from here; the only disk
   * write is the echo-guarded outbound materialize of a doc whose live index path is
   * `newPath` (the content the index ALREADY records). OFFLINE-EDIT SAFETY: the rename
   * never reaches `onDelete`'s `clearDirty` (suppressed), so an edited-but-unpushed doc
   * keeps its dirty flag across the rename; if its edited content is what is missing at
   * `newPath`, `materializeLiveDiskContent`'s dirty-aware path (driven by the convergence
   * loop) reconciles it — we only materialize here when the doc has CONVERGED to the
   * indexed content (see {@link materializeLiveDiskContent}'s gate, which we reuse).
   */
  private async settleRenameTransactions(): Promise<void> {
    const open = this.renameTxn.openTransactions();
    if (open.length === 0) return;
    for (const txn of open) {
      // Close FIRST so the quarantine is lifted before we materialize (the materialize's
      // own echo-guarded write must not be re-suppressed as rename fallout).
      this.renameTxn.close(txn.newPath);
      const entry = this.index.get(txn.newPath);
      // Only act on a still-LIVE renamed entry (a later divergent-rename resolution may
      // have tombstoned this key; that path is owned by structural reconcile).
      if (entry === undefined || entry.deleted === true) continue;
      const bytes = await this.ports.vault.read(txn.newPath);
      if (bytes !== null) continue; // file present — invariant already holds.
      // File missing at the new path (the residual bug's loss): re-materialize the
      // renamed content from the attached doc. `materializeLiveDiskContent` is gated
      // (doc==stamp, disk behind/absent, anti-clobber) and echo-guarded — it writes the
      // canonical content for any live entry whose disk lags, which now includes newPath.
    }
    // One materialize pass covers every live entry whose disk lags (incl. any newPath we
    // found missing). Idempotent + loop-safe — see materializeLiveDiskContent's contract.
    await this.materializeLiveDiskContent();
  }

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
      // BLOB at bootstrap (0b-3 Fix 3, sub-gap): a binary/structured blob already on disk
      // when the engine starts must be PUBLISHED (content-address + store + manifest) — the
      // SAME local-write path runtime writes take via onWrite. Without this a blob present at
      // fixture-load time is never advertised, so a follower never learns to fetch it. Safe:
      // onLocalBlobWrite touches only the blob store + manifest (a local-authored write); it
      // does NOT write the vault, so it cannot perturb the prose bootstrap path below.
      // PROJECTOR GUARD (0b-3 MINOR): a read-only projector must NOT be a second write
      // authority — the runtime onWrite blob branch is gated by `ingestDisabled`, so the
      // bootstrap blob-publish must honour the same gate (skip publishing in projector mode).
      if (route === "structured-blob" || route === "binary-blob") {
        if (this.config.ingestDisabled === true) continue;
        await this.blobEngine.onLocalBlobWrite(path, bytes);
        continue;
      }
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
          // every device agrees on (so the loser's content is recovered, never lost). The
          // after-start create path mints meta the SAME way via {@link seedCreateMeta}.
          this.writeCreateMeta(doc, path);
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
   *
   * WATCHER-TRANSACTION (0b-3, GPT-5.5 root cause). The REAL recursive watcher emits
   * ASYNC, possibly-REORDERED `delete`/`modify` fallout after the physical move — incl.
   * a `delete(newPath)` (not just the ideal `delete(old)+modify(new)`). Un-quarantined,
   * a `delete(new)` tombstones the live renamed docId and the structural delete concern
   * then removes the file (the residual bug). So — whether this is the originating
   * rename OR the already-reflected echo of structural reconcile's `vault.rename` — we
   * OPEN a transaction quarantining BOTH paths (keyed to the renamed entry's content
   * hash; a rename preserves the stamp, and the moved file carries that content) and
   * schedule a settle that reconciles the on-disk invariant. {@link onDelete} /
   * {@link onWrite} consult the quarantine; the settle closes it. Runs synchronously
   * (the hash is read from the index entry, not the disk) so the quarantine is in place
   * before the watcher's deferred follow-up events arrive.
   */
  private onRename(oldPath: VaultPath, newPath: VaultPath): void {
    const from = this.index.get(oldPath);
    const to = this.index.get(newPath);
    // Move already reflected: new path live + old path tombstoned, SAME docId.
    const alreadyReflected =
      from?.deleted === true && to !== undefined && to.deleted !== true && to.docId === from.docId;
    if (!alreadyReflected) applyRename(this.index, oldPath, newPath);
    // Open a transaction over both paths, bound to the renamed entry's content hash.
    const renamed = this.index.get(newPath);
    if (renamed !== undefined) {
      this.renameTxn.open(oldPath, newPath, renamed.docId, stampHash(renamed.stamp));
      this.scheduleRenameSettle();
    }
  }

  /** A create/modify: route by sticky classify; prose → ingest, blob → blob engine. */
  private async onWrite(path: VaultPath): Promise<void> {
    // Projector mode (0b-3 Part C): a read-only projection target must NOT ingest its
    // own local writes (no prose ingest, no local blob write) — doing so would make it
    // a second write authority. Outbound (remote→disk) + bootstrap-seed still run.
    if (this.config.ingestDisabled === true) return;

    const bytes = await this.ports.vault.read(path);
    if (bytes === null) return;

    // RENAME-TRANSACTION SUPPRESSION (0b-3): while a rename transaction quarantines this
    // path, a `modify` carrying the renamed content hash is the watcher's own rename echo
    // — SUPPRESS it. Ingesting would re-stamp the index under THIS device + markDirty,
    // which (relayed to a peer) reorders the peer's materialize ahead of its structural
    // rename and strands the old file. Content-bound: a GENUINE later edit (different
    // hash) is NOT suppressed and passes through. Checked before classify so a blob
    // rename echo is suppressed too. Re-arm the settle so a late echo extends the window.
    const writeHash = await sha256OfBytes(bytes);
    if (this.renameTxn.suppressModify(path, writeHash)) {
      this.scheduleRenameSettle();
      return;
    }

    const entry = this.index.get(path);
    const route = entry?.type ?? classify(path, bytes, this.caps).route;

    switch (route) {
      case "crdt-prose":
        await this.ingest.onVaultWrite(path);
        return;
      case "structured-blob":
      case "binary-blob": {
        // ECHO-GUARD (0b-3 loop fix): mirror prose ingest's echo-skip (bridge/ingest.ts).
        // `BlobEngine.materialize` echo-records the sha IMMEDIATELY before its `vault.writeAtomic`,
        // so the resulting fs "modify" event lands here as the echo of our OWN materialize. Without
        // this guard, re-publishing via `onLocalBlobWrite` re-stamps the manifest under THIS device
        // (origin "local-bridge", which the transport RELAYS) → observe → onManifestChange →
        // materialize → write → fs event → … an unbounded feedback loop that floods disk + the
        // relay. If this write is that echo, SKIP: do NOT re-publish. The shared EchoLedger is
        // multi-entry/consume-once, used here exactly as ingest uses it. (`writeHash` is the
        // blob's sha — already computed above for the rename-transaction check.)
        if (this.echo.isEcho(path, writeHash)) return;
        await this.blobEngine.onLocalBlobWrite(path, bytes);
        return;
      }
      case "config":
      case "excluded":
        return;
    }
  }

  /** A delete: lay an edit-beats-delete tombstone keyed on the doc's last content hash. */
  private async onDelete(path: VaultPath): Promise<void> {
    // RENAME-TRANSACTION SUPPRESSION (0b-3): a real recursive watcher emits ASYNC,
    // possibly-REORDERED delete fallout after a physical rename — for the OLD path AND,
    // crucially, sometimes for the NEW path (a `delete(new)`). While a rename transaction
    // quarantines EITHER side, SUPPRESS the delete: tombstoning would clobber the renamed
    // (live) docId and let structural reconcile remove the file (the residual bug), and
    // `clearDirty` would lose an edited-but-unpushed doc renamed in the same offline
    // window (the edit-then-rename hazard). The quarantine is lifted at settle, so a
    // genuine later user delete of `path` is NOT swallowed. Re-arm the settle so a late
    // delete extends the window.
    if (this.renameTxn.suppressDelete(path)) {
      this.scheduleRenameSettle();
      return;
    }
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
