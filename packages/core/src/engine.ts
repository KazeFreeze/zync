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
  DeviceId,
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
import { matchRenames } from "./protocol/rename-match.js";
import { IndexDoc } from "./protocol/index-doc.js";
import type { TreeEntry } from "./protocol/index-doc.js";
import { LazyAttachManager } from "./protocol/lazy-attach.js";
import { runStructuralReconcile } from "./protocol/structural-reconcile.js";
import { applyBootstrap } from "./protocol/bootstrap.js";
import { supervisedImport } from "./conflicts/supervised-import.js";
import { orphanSweep, orphanRecoveryPath, type OrphanMeta } from "./protocol/orphan-sweep.js";
import { makeStamp, stampHash, stampsEqual } from "./protocol/stamp.js";
import { BlobEngine, type BlobFetchPolicy, type BlobManifestEntry } from "./blobs/blob-engine.js";
import { Inbox } from "./conflicts/inbox.js";
import { conflictArtifactPath, writeConflictArtifact } from "./conflicts/artifact.js";
import { ArtifactNotLocalError, type ResolveAction } from "./conflicts/resolve.js";
import { canonicalizeProse, sha256OfBytes, sha256OfText } from "./hash.js";
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
  /** Background blob fetch queue: max concurrent fetches. Default 4. */
  blobFetchConcurrency?: number;
  /** Background blob fetch queue: max in-flight bytes (admission budget). Default 96 MiB. */
  maxInFlightBlobBytes?: number;
  /** Background blob fetch queue: max typed-retry attempts before parking. Default 4. */
  blobFetchMaxRetries?: number;
  /** Background blob fetch queue: heal-retry tick (ms) for re-trying parked failures. Default 45000. */
  blobRetryTickMs?: number;
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
   * M3 live-rename coalescer: base debounce window (ms) for the rename-signal buffer. A
   * bound-live prose `delete` (rename SOURCE) and a write to an unbound path (rename TARGET) are
   * held for this long (RE-ARMED on each newly-buffered signal) then drained through the same
   * pure `matchRenames` core as bootstrap. Default 300 (the M1-settled value). Configurable like
   * {@link renameSettleMs}.
   */
  renameWindowMs?: number;
  /**
   * M3 live-rename coalescer: HARD CAP (ms) on the debounce window so a folder-move BURST always
   * drains as one batch rather than splitting delete/create pairs across drains. Measured from the
   * first armed signal. Default 1000.
   */
  renameWindowCapMs?: number;
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

/** Atomic-write / temp-file churn must never be treated as a rename target. */
function isTempPath(path: string): boolean {
  return path.includes(".tmp");
}
/** Default rename-transaction settle window (ms) — see {@link EngineConfig.renameSettleMs}. */
const DEFAULT_RENAME_SETTLE_MS = 60;
/** Default M3 live-rename coalescer debounce + cap (ms) — see {@link EngineConfig.renameWindowMs}. */
const DEFAULT_RENAME_WINDOW_MS = 300;
const DEFAULT_RENAME_WINDOW_CAP_MS = 1000;
/** Defaults for the BlobEngine's bounded fetch queue (blob-fetch orchestration, P1). */
const DEFAULT_BLOB_CONCURRENCY = 4;
const DEFAULT_MAX_INFLIGHT_BLOB_BYTES = 96 * 1024 * 1024;
const DEFAULT_BLOB_MAX_RETRIES = 4;
const DEFAULT_BLOB_RETRY_TICK_MS = 45_000;

/**
 * An unmatched-lost entry (live prose, file absent, base present, NOT a rename) DEFERRED past the
 * bootstrap seed loop so a later task can let the seed loop consume an in-place collision first.
 * Carries everything the post-seed-loop handler needs to replay the M1a/M1b decision WITHOUT
 * re-reading base: the LOCAL base text (materialize source) + the persisted materializedHash (the
 * M1b clean-delete signal). `hash` is the LOCAL base.fileHash (== sha256OfText(baseText)).
 */
interface DeferredLost {
  path: VaultPath;
  docId: DocId;
  hash: string;
  baseText: string;
  materializedHash: Sha256 | undefined;
}
/** Two deferred-lost entries share a content hash → the hash is not a unique key (used by a later task). */
const AMBIGUOUS = Symbol("ambiguous-lost-content");

/**
 * S6c: Quiescence debounce (ms). After the reconcile loop goes idle, wait this long
 * before triggering a full convergence audit. Re-armed on every reconcile activity
 * so it only fires after a true quiet period.
 *
 * O(n^2)-AVOIDANCE (F2 — set from the on-device profile). The earlier 2000ms value
 * fired ~70 audits DURING a real-relay first sync: a relay-bound seed is NOT
 * "continuously busy" — index echoes arrive ~1-2/sec with brief lulls, and every lull
 * longer than the window was (falsely) read as quiescence, firing a full O(n) audit.
 * Audit-count then scaled with seed duration (which scales with n) -> O(n^2). The
 * window must comfortably EXCEED the inter-echo gap so an actively-seeding loop keeps
 * re-arming it and it fires only at a GENUINE pause (true settle). 15s sits well above
 * the ~1/sec echo cadence yet below the watchdog floor, giving O(1) audits per seed.
 * (The progress-aware watchdog handles the "busy but stuck/long" floor separately.)
 */
export const AUDIT_QUIESCENCE_MS = 15_000;

/**
 * S6c: Watchdog max staleness (ms). If the reconcile loop stays continuously busy
 * for longer than this without a full audit, the watchdog fires ONE audit (one-shot
 * latch per busy epoch, not repeating). Default 30 seconds.
 *
 * O(n^2)-AVOIDANCE: the one-shot latch (`auditedThisBusyEpoch`) ensures at most ONE
 * watchdog audit per continuous-busy epoch regardless of how long the storm lasts.
 * A repeating timer would fire ~(storm_duration/interval) times -> O(n^2). The latch
 * is the load-bearing O(n^2) guard — tests verify removing it causes repeated firing.
 */
export const AUDIT_MAX_STALENESS_MS = 30_000;

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

  /**
   * Stage 3: docIds with a divergence RECORDED (in `priorDivergence`) but NOT YET RESOLVED
   * on the CURRENT pass (the `confirmDivergence` seam returned `false` — the stability gate
   * awaits a second consecutive sighting). Distinct from `priorDivergence` (which holds the
   * SIGNATURE map); this is a WORK QUEUE of docIds that MUST appear in the next structural
   * pass's workset.
   *
   * ENQUEUE: when `confirmDivergence` records a divergence for a docId but returns `false`
   * (i.e. it is not yet confirmed/resolved — goes into `priorDivergence` awaiting the next
   * pass). DRAIN: when the docId is observed with <=1 live path (non-divergent) OR after
   * `applyRenameConflictResolution` runs and the post-check confirms <=1 live path.
   *
   * WHY NEEDED (S4+): under scoping, "next pass" may not visit the diverged docId. This set
   * forces it into the next structural pass so the two-consecutive-pass stability gate can
   * complete. (Risk #3 in CURSOR-GPT-KEYSCOPED-RECONCILE-FINDINGS.md.)
   */
  private readonly pendingDivergenceDocIds = new Set<DocId>();
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
  /**
   * F1 reconnect-backstop subscription. Unsubscribed in stop() so no status callback
   * fires after the engine is torn down.
   */
  private transportUnsub: Unsubscribe | null = null;
  /**
   * F1 reconnect-backstop flag. Set to `true` once start()'s step-9 full pass is
   * scheduled, so the onStatus handler can distinguish the initial connect (already
   * handled by step 9) from a genuine RECONNECT (offline → connected transition that
   * needs a fresh full pass to re-push offline-accumulated dirty docs).
   */
  private startupDone = false;

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
   * Stage 4a: per-path docId cache used as a safety net for paths that have left the index
   * CRDT map entirely (not even a tombstone remains). Populated in the `index.observe` handler
   * from each changed path's CURRENT docId — captured BEFORE the observe callback returns.
   * When `buildWorksetWithMaps` sees a changed path absent from the index, it falls back here
   * so the docId is still included in the workset.
   *
   * In practice tombstones keep the docId resolvable indefinitely (IndexDoc does not hard-delete),
   * so this branch is forward-insurance rather than a common code path.
   *
   * BOUNDED: paths whose docId is now in the live or tombstoned index are pruned during
   * `buildWorksetWithMaps` so the cache does not grow indefinitely.
   */
  private readonly prevEntryByPath = new Map<VaultPath, DocId>();

  /**
   * S6a — self-draining backstop flag. Set to `true` when a GENUINELY NEW docId enters any
   * backstop set ({@link pendingDivergenceDocIds}, {@link LazyAttachManager.needsCatchUp}, or
   * {@link LazyAttachManager.remoteUpdatedSinceSettle}) — i.e. when {@link onBackstopWork} fires
   * or when `pendingDivergenceDocIds.add` is called for a docId not already in the set.
   *
   * `runReconcileLoop` checks this flag alongside `pendingChangedPaths` so a backstop-only
   * enqueue (with no further index.observe) still gets a draining pass. Consumed (reset to false)
   * at the TOP of each loop iteration; a new enqueue mid-pass re-sets it so the loop continues.
   *
   * ANTI-SPIN: the flag is set ONLY on a genuinely-new set member. Re-adding a docId already
   * present in a backstop set (e.g. a persistent ack timeout re-adding to needsCatchUp) must NOT
   * set this flag — so after ONE retry pass the loop exits even if the doc remains stuck.
   *
   * STALE-TRUE IS SAFE — DO NOT "fix" it by resetting in {@link runFullConvergencePass}. A full
   * pass drains every backstop set but does not clear this flag (and an enqueue can fire between
   * the last drain and the finally). Leaving it true costs at most ONE backstop-only pass over
   * already-drained sets (a no-op: empty unions + openDocIds find nothing new). Resetting it in
   * the full pass's finally would instead risk dropping a genuinely-new enqueue that raced it.
   */
  private freshBackstopWork = false;

  // DURABLE WORK-QUEUE COALESCER (Stage 2 — replaces the three-boolean coalescer).
  //
  // Stage 1 coalescer (boolean flags): bounded to one pass in flight, re-ran once more if any
  // change arrived mid-pass (reconcileAgain). Caught the O(n^2) burst. BUT: it discarded the
  // changed paths delivered by IndexDoc.observe, and on a thrown pass the gate resolved early
  // (before the work was done), letting whenIdle falsely report idle while pending work remained.
  //
  // Stage 2 coalescer: accumulates the ACTUAL changed paths from IndexDoc.observe, threads them
  // as a durable work queue so no path is ever dropped on throw, and tracks the REAL loop promise
  // (not a manual gate) so whenIdle/waitConverged await real work and see real rejections.
  //
  // Invariants:
  //   (a) Every VaultPath delivered by IndexDoc.observe lands in pendingChangedPaths.
  //   (b) A running pass drains pendingChangedPaths into runningBatch at loop-start; new changes
  //       that arrive MID-PASS land in pendingChangedPaths (next iteration), never lost.
  //   (c) On THROW: runningBatch paths are re-added to pendingChangedPaths, a fresh pass is
  //       scheduled, and the loop promise rejects (so whenIdle/allSettled sees the failure).
  //   (d) On SUCCESS: runningBatch is cleared; loop continues if pendingChangedPaths is non-empty.
  //   (e) whenIdle drains inflight with allSettled — sees the real loop promise, never a manual gate.
  //
  // Post-S6b the observe path is FULLY SCOPED: runCatchUp (S4b), materializeLiveDiskContent
  // (S4c), structuralReconcile's tombstone/divergent loops (S5), and settleCleanDocs (S6b)
  // all iterate only the workset. Only runFullConvergencePass (waitConverged/startup) remains
  // unscoped. The batch is still collected here as the durable durability boundary (on throw,
  // paths are re-queued so no index event is ever dropped).
  private readonly pendingChangedPaths = new Set<VaultPath>();
  // The set of paths snapshotted into the currently-running pass (cleared on success, re-queued
  // on throw). Kept separate from pendingChangedPaths so mid-pass changes land in the pending set
  // and can never be lost even if the running pass throws.
  private runningBatch = new Set<VaultPath>();
  // True while the reconcile loop promise is in flight. Prevents double-scheduling.
  private reconcileLoopRunning = false;
  /**
   * S6a: true while `runFullConvergencePass` is executing. Used in the `onBackstopWork` seam
   * to suppress `scheduleReconcile()` calls from `LazyAttachManager` callbacks that fire
   * mid-`runFullConvergencePass` (e.g. enqueue from the full-path precheck or ack-timeout
   * workers). A `runFullConvergencePass` call already processes all backstop sets, so firing
   * `scheduleReconcile()` there would spawn a parallel reconcile loop that runs CONCURRENTLY
   * with the rest of the full pass — causing races and false-not-settled failures.
   *
   * `onBackstopWork` only needs to schedule the loop when triggered OUTSIDE of a
   * `runFullConvergencePass` context (i.e. from the `bindOutbound` remote-update path or
   * from the observe-loop's pass workers when no further observe will come). When inside a
   * full convergence pass the pass already handles all sets — scheduling is a no-op at best,
   * harmful at worst.
   */
  private inFullConvergencePass = false;

  // ── S6c: hybrid low-frequency full convergence audit ────────────────────────
  //
  // Two triggers, both routing the audit through the reconcile loop (serialized +
  // tracked for free via the loop promise):
  //
  // 1. QUIESCENCE-DEBOUNCED: after every period of reconcile activity, a debounced
  //    timer fires once the loop has been idle for AUDIT_QUIESCENCE_MS (re-armed on each
  //    loop iteration so it fires only after true quiescence). F2 WORK-AWARE GATE: when it
  //    fires it requests the audit ONLY if `hasOutstandingWork()` is false (all scoped-path
  //    backstop sets empty); if work remains it suppresses the audit (the scoped passes are
  //    still converging). Firing always ends the current busy epoch (resets the watchdog).
  //
  // 2. WATCHDOG (PROGRESS-AWARE, ONE-SHOT PER STALL): armed when a busy epoch starts. On
  //    fire (after AUDIT_MAX_STALENESS_MS) it RE-ARMS without auditing if `reconcileProgressTick`
  //    advanced since it was armed (the loop is making progress — a healthy seed, not stuck);
  //    it fires ONE audit only when the tick is UNCHANGED (genuinely STALLED). The
  //    `auditedThisBusyEpoch` latch then prevents re-firing within the same epoch. So a healthy
  //    progressing seed produces ZERO watchdog audits; the watchdog is the floor for stuck systems.
  //
  // Busy epoch lifecycle:
  //   START: when scheduleReconcile arms a loop that was NOT already running.
  //   END:   when quiescence timer fires (loop went idle for the full window).
  //
  // O(n^2)-AVOIDANCE (F2, from the on-device profile): a relay-bound seed is NOT continuously
  // busy — index echoes arrive ~1/sec with brief lulls. At the old 2s quiescence window every
  // lull was read as quiescence -> a full O(n) audit -> audit-count scaled with seed duration
  // (~n) -> O(n^2). The 15s window (> echo cadence) + the work-aware quiescence gate + the
  // progress-aware watchdog together make a healthy seed produce O(1) full audits regardless of n.

  /** S6c: a full audit is requested (set by quiescence timer or watchdog). */
  private auditRequested = false;

  /**
   * S6c: quiescence debounce timer. Re-armed (clear + set) whenever reconcile
   * activity occurs. When it fires (loop idle for AUDIT_QUIESCENCE_MS), sets
   * `auditRequested` and calls `scheduleReconcile()`. Also ends the busy epoch.
   */
  private auditQuiescenceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * S6c/F2: watchdog timer for the current busy epoch. Armed when a new busy epoch starts
   * (scheduleReconcile arms an idle loop). On fire (after AUDIT_MAX_STALENESS_MS) it is
   * PROGRESS-AWARE — see {@link armWatchdogTimer}: it re-arms WITHOUT auditing if
   * `reconcileProgressTick` advanced (system progressing), and fires the audit only on a
   * genuine STALL (tick unchanged). The latch then blocks re-fire within the epoch.
   */
  private auditStaleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * S6c: one-shot latch for the current busy epoch. Set to `true` when the watchdog
   * fires an audit; prevents the watchdog from firing again in the same epoch.
   * Reset to `false` when the epoch ends (the quiescence timer fires).
   *
   * NOTE: this INTENTIONALLY persists across epoch boundaries until a quiescence fire resets
   * it — a stall is ultimately covered by the quiescence path (a stalled loop goes idle ->
   * quiescence fires -> audit + reset). Do NOT "fix" it into a per-epoch reset; that would
   * re-open the watchdog double-fire the latch guards against.
   */
  private auditedThisBusyEpoch = false;

  /**
   * F2: monotonic progress counter, bumped on any convergence activity.
   *
   * Incremented in three places:
   *   1. `index.observe` handler — an index event arrived (work incoming).
   *   2. Scoped-pass loop — a non-empty workset was processed (real work done).
   *   3. `bindOutbound` remote-update handler — an incoming remote note-doc update
   *      arrived (the relay is delivering progress).
   *
   * The watchdog snapshots this on arm; if the tick has NOT advanced when the watchdog
   * fires, the system is genuinely STALLED — fire the audit. If it HAS advanced, the
   * system is making progress (healthy seed) — suppress the audit and re-arm the watchdog
   * for another window.
   *
   * O(1): always just `this.reconcileProgressTick++`. Wrapping at MAX_SAFE_INTEGER is
   * harmless (the watchdog only cares about `tickNow !== tickAtArm`; a wrap causes at
   * most one false-stall false-positive every 2^53 ticks — effectively never).
   */
  private reconcileProgressTick = 0;

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

  /**
   * M3 live-rename coalescer buffer. {@link onVaultEvent} holds the two rename SIGNALS — a bound-live
   * prose `delete` (a SOURCE: capture `docId` + `base.fileHash`) and a write to an UNBOUND path (a
   * TARGET) — for a debounced+capped window, then {@link drainRenameBuffer} resolves them through the
   * SAME pure `matchRenames` core as bootstrap (re-key a content-matched pair with docId continuity;
   * no spurious delete propagated). `draining` single-flights the drain. Part of quiescence (Task 4):
   * buffered signals count toward {@link pendingDocs}; {@link whenIdle} force-drains it.
   */
  private renameBuf: {
    sources: Map<VaultPath, { docId: DocId; hash: Sha256 }>;
    targets: Set<VaultPath>;
    // In-flight source-buffer promises (each awaits a base.load). A timer-driven drain awaits these
    // before snapshotting so it never acts on a half-populated buffer (F1).
    pendingSources: Set<Promise<void>>;
    // Targets a drain has snapshotted (removed from `targets`) but not yet finished reading. `requestRename`
    // consults this too so it cannot clobber an external target whose bytes are mid-drain (F2).
    drainingTargets: Set<VaultPath>;
    // Barrier clause 1: a source's path is owned across base.load (pendingSourcePaths) and the drain
    // (drainingSources), bridging the gaps where `sources` is empty (during load / after snapshot).
    pendingSourcePaths: Set<VaultPath>;
    drainingSources: Set<VaultPath>;
    timer: ReturnType<typeof setTimeout> | null;
    firstArmedAt: number | null;
    draining: Promise<void> | null;
  } = {
    sources: new Map(),
    targets: new Set(),
    pendingSources: new Set(),
    drainingTargets: new Set(),
    pendingSourcePaths: new Set(),
    drainingSources: new Set(),
    timer: null,
    firstArmedAt: null,
    draining: null,
  };
  private readonly renameWindowMs: number; // base debounce (default 300)
  private readonly renameWindowCapMs: number; // hard cap so a burst always drains (default 1000)

  constructor(ports: EnginePorts, config: EngineConfig) {
    this.ports = ports;
    this.config = config;
    this.substrate = config.substrate ?? "yjs";
    this.caps = { maxProseBytes: config.maxProseBytes, configDir: config.configDir };
    this.debounceMs = config.stampDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.renameSettleMs = config.renameSettleMs ?? DEFAULT_RENAME_SETTLE_MS;
    this.renameWindowMs = config.renameWindowMs ?? DEFAULT_RENAME_WINDOW_MS;
    this.renameWindowCapMs = config.renameWindowCapMs ?? DEFAULT_RENAME_WINDOW_CAP_MS;
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
      clock: this.ports.clock,
      concurrency: this.config.blobFetchConcurrency ?? DEFAULT_BLOB_CONCURRENCY,
      maxInFlightBytes: this.config.maxInFlightBlobBytes ?? DEFAULT_MAX_INFLIGHT_BLOB_BYTES,
      maxRetries: this.config.blobFetchMaxRetries ?? DEFAULT_BLOB_MAX_RETRIES,
      retryTickMs: this.config.blobRetryTickMs ?? DEFAULT_BLOB_RETRY_TICK_MS,
      onBlobFailure: (paths) => {
        this.surfaceBlobFailures(paths);
      },
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
      // S6a: self-draining backstop seam — fires when a GENUINELY NEW docId enters needsCatchUp
      // or remoteUpdatedSinceSettle (the "new to set" guard in LazyAttachManager ensures re-adds
      // do NOT invoke this, which is the anti-spin guarantee). Sets freshBackstopWork and
      // schedules a wakeup so the reconcile loop re-runs for backstop-only work.
      //
      // IMPORTANT: suppressed (via inFullConvergencePass) when the enqueue fires from INSIDE a
      // runFullConvergencePass call — that call already handles all backstop sets, so scheduling
      // a parallel observe-loop there would race the full pass and cause false non-settle failures.
      onBackstopWork: () => {
        this.freshBackstopWork = true;
        if (!this.inFullConvergencePass) {
          this.scheduleReconcile();
        }
      },
    });

    // 6. Bootstrap: seed local prose that has no index entry yet; then sweep orphans.
    await this.bootstrap();

    // 7. Subscribe vault events (each handler tracked so whenIdle awaits it).
    this.vaultUnsub = this.ports.vault.onEvent((e) => {
      this.onVaultEvent(e);
    });

    // 8. Subscribe index changes → pull peers' bumped docs via catch-up, then reconcile the inbound
    //    index against the vault (inbound tombstone → vault.remove). Structural reconcile runs AFTER
    //    catch-up so a doc the same index change attaches is materialized before we judge its disk
    //    state. COALESCED (not one chain per transaction) — see {@link scheduleReconcile}.
    //    Stage 2: thread the changed paths into pendingChangedPaths so they are durable across
    //    a thrown pass (no path is ever dropped).
    //    Stage 4a: BEFORE recording each changed path, capture its CURRENT docId into
    //    prevEntryByPath so that buildWorkset can resolve a path even after it is removed from
    //    the live index (tombstoned or re-keyed). The CURRENT docId is snapshotted here, at the
    //    moment the observe callback fires (the CRDT has applied the change, so index.get(p)
    //    returns the NEW value — which for a tombstone still carries the docId; for a path now
    //    absent from the map it returns undefined and we fall back to the prior cached value).
    this.indexUnsub = this.index.observe((changedPaths) => {
      for (const p of changedPaths) {
        // Capture the docId from the CURRENT index entry (may be tombstoned or live).
        const currentDocId = this.index.get(p)?.docId;
        if (currentDocId !== undefined) {
          this.prevEntryByPath.set(p, currentDocId);
        }
        this.pendingChangedPaths.add(p);
      }
      // F2: bump the progress counter on every index event — signals active work incoming.
      this.reconcileProgressTick++;
      this.scheduleReconcile();
    });

    // 9. Initial catch-up so an adopting device pulls everything the index already
    //    lists, then an initial structural reconcile so a tombstone already present
    //    at adopt time is applied.
    //    Stage 4a: routes through runFullConvergencePass() — the named full-chain entry
    //    point. Startup / flush / waitConverged / the future periodic audit MUST always
    //    use runFullConvergencePass() (never the scoped helper).
    //    F1: set startupDone BEFORE tracking the pass so the onStatus handler (subscribed
    //    in step 10) never fires a SECOND full pass for the initial connect.
    this.startupDone = true;
    this.track(this.runFullConvergencePass());

    // 10. F1 reconnect-backstop: subscribe to transport status changes and fire a
    //     reconnect catch-up on every genuine offline→connected RECONNECT (not the
    //     initial connect — step 9 covers that). This re-pushes any dirty docs that
    //     were edited OFFLINE and whose index-observe already drained from
    //     pendingChangedPaths while offline (catch-up early-returns offline so they
    //     never entered needsCatchUp). Without this, those offline edits are stranded
    //     on reconnect → silent data loss.
    //
    //     FILTER: fire on the FIRST "connected" after the transport has been "offline"
    //     since the last connect. We LATCH "saw offline" rather than comparing only the
    //     IMMEDIATELY-preceding status, because the real Hocuspocus transport reconnects
    //     via offline -> CONNECTING -> connected (transport-hocuspocus.ts maps
    //     WebSocketStatus.Connecting -> "connecting"). A guard that required the prior
    //     status to be exactly "offline" would see "connecting" at the connected event and
    //     SILENTLY NOT FIRE on a real reconnect — stranding offline edits (the in-process
    //     mock hides this: goOnline() jumps straight offline->connected). The latch fires
    //     correctly for both transition shapes. ("unauthorized" is treated like offline:
    //     a session that recovers from it also needs the re-push.)
    //
    //     ACTIVE-BOUND SAFETY: we call runCatchUp with an EMPTY openDocIds (not the
    //     engine's live openDocIds). Active-bound docs have their editor edits handled
    //     by the CRDT transport's auto-resync (state-vector exchange on reconnect) and
    //     do NOT need the dirty-reconcile path here. Including them would advance their
    //     synced stamp to the merged CRDT text while the index hasn't been bumped for
    //     the merged content — creating a false-pending latch (stamp != synced forever
    //     until the editor autosaves + ingest bumps the index). Passing an empty
    //     openDocIds means open docs are only selected if their stamp != synced (e.g.
    //     a dirty-and-open doc whose local ingest bumped the stamp while offline — those
    //     ARE correctly selected and re-pushed).
    let sawOfflineSinceConnected = transport.status() !== "connected";
    this.transportUnsub = transport.onStatus((s) => {
      if (s === "offline" || s === "unauthorized") {
        sawOfflineSinceConnected = true;
        return;
      }
      if (s === "connected" && sawOfflineSinceConnected && this.startupDone) {
        // Genuine RECONNECT (offline -> [connecting] -> connected, after startup). Re-push
        // all dirty docs via catch-up. EMPTY openDocIds: open docs are handled by CRDT
        // transport resync; including them would falsely advance their synced stamp (see
        // ACTIVE-BOUND SAFETY). Clear the latch so a later spurious "connected" does not re-fire.
        //
        // CATCH-UP-ONLY BY DESIGN: this does NOT run the full structural/settle/orphan chain (a
        // full pass would force-select active-bound docs and false-latch them). It re-pushes the
        // dirty content; a tombstone/rename that arrived during the partition is applied by the
        // next index-observe scoped pass (the index auto-resyncs on reconnect) or, worst case, the
        // S6c audit — bounded staleness, NOT loss.
        sawOfflineSinceConnected = false;
        this.track(this.lazyAttach.runCatchUp(new Set()));
      }
    });
  }

  async stop(): Promise<void> {
    // Settle anything still in flight so stop() leaves no open work.
    await this.whenIdle();

    this.vaultUnsub?.();
    this.indexUnsub?.();
    this.blobUnsub?.();
    this.transportUnsub?.();
    this.vaultUnsub = null;
    this.indexUnsub = null;
    this.blobUnsub = null;
    this.transportUnsub = null;

    for (const pending of this.pendingBumps.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.resolve();
    }
    this.pendingBumps.clear();

    // S6c: clear audit timers so no dangling timer fires after stop().
    if (this.auditQuiescenceTimer !== null) {
      clearTimeout(this.auditQuiescenceTimer);
      this.auditQuiescenceTimer = null;
    }
    if (this.auditStaleTimer !== null) {
      clearTimeout(this.auditStaleTimer);
      this.auditStaleTimer = null;
    }

    // M3: clear the live-rename debounce timer so no dangling drain fires after stop() (whenIdle above
    // already force-drained the buffer; this only releases an armed-but-not-yet-fired timer).
    if (this.renameBuf.timer !== null) {
      clearTimeout(this.renameBuf.timer);
      this.renameBuf.timer = null;
    }

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

  /**
   * Stage 3: expose the {@link LazyAttachManager} for direct backstop-set seam access
   * in tests (`needsCatchUpSnapshot`, `remoteUpdatedSinceSettleSnapshot`, `noteRemoteUpdate`,
   * `addNeedsCatchUp`). Only available after {@link start} initializes it.
   */
  get lazyAttachManager(): LazyAttachManager {
    return this.lazyAttach;
  }

  /**
   * Stage 3: READ-ONLY snapshot of {@link pendingDivergenceDocIds} for test assertions.
   * Returns a fresh `Set` copy so callers cannot mutate internal state.
   */
  pendingDivergenceDocIdsSnapshot(): ReadonlySet<DocId> {
    return new Set(this.pendingDivergenceDocIds);
  }

  /**
   * Stage 3: enqueue a docId into {@link pendingDivergenceDocIds}. TEST-ONLY seam to simulate
   * "pass recorded a divergence but did not resolve it". Production does NOT call this — it adds
   * via {@link enqueuePendingDivergenceDocId} in `structuralReconcile`'s `confirmDivergence`
   * closure. Routes through the private helper so the S6a anti-spin guard applies uniformly.
   */
  addPendingDivergenceDocId(docId: DocId): void {
    this.enqueuePendingDivergenceDocId(docId);
  }

  /**
   * Stage 3: drain a docId from {@link pendingDivergenceDocIds}. TEST-ONLY seam to simulate
   * "divergence observed as resolved (<=1 live path)". Production does NOT call this — the
   * post-reconcile drain loop in `structuralReconcile` deletes from the field directly.
   */
  clearPendingDivergenceDocId(docId: DocId): void {
    this.pendingDivergenceDocIds.delete(docId);
  }

  /**
   * S6a: internal helper — add docId to {@link pendingDivergenceDocIds} with the "genuinely new"
   * guard. Only sets {@link freshBackstopWork} and calls {@link scheduleReconcile} when the docId
   * was not already in the set (anti-spin guarantee). Used by the `confirmDivergence` closure in
   * `structuralReconcile` (the production path) and by {@link addPendingDivergenceDocId} (the
   * test seam). Must remain private — callers outside this class use the test seam only.
   */
  private enqueuePendingDivergenceDocId(docId: DocId): void {
    if (!this.pendingDivergenceDocIds.has(docId)) {
      this.pendingDivergenceDocIds.add(docId);
      this.freshBackstopWork = true;
      // S6a: suppress scheduleReconcile() when inside runFullConvergencePass — that call already
      // handles pendingDivergenceDocIds via its structuralReconcile + full workset, so scheduling
      // a parallel observe-loop from here would race the full pass unnecessarily.
      if (!this.inFullConvergencePass) {
        this.scheduleReconcile();
      }
    }
    // Re-add is a no-op for Sets, and we intentionally do NOT set freshBackstopWork for a
    // re-add — a docId already in the set was already scheduled for a draining pass, and
    // re-setting the flag would cause an extra pass each time any stability-gate re-sighting
    // fires on a persistently-divergent docId (spin risk).
  }

  /**
   * Stage 3: READ-ONLY snapshot of `lazyAttach.remoteUpdatedSinceSettle` via the manager's
   * seam. Delegates to {@link LazyAttachManager.remoteUpdatedSinceSettleSnapshot}. Only
   * valid after {@link start} initializes the manager.
   */
  remoteUpdatedSinceSettleSnapshot(): ReadonlySet<DocId> {
    return this.lazyAttach.remoteUpdatedSinceSettleSnapshot();
  }

  /** Resolves when NO reconcile is in flight (drains the tracked set; flushes bumps first). */
  async whenIdle(): Promise<void> {
    this.flushBumps();
    // M3: FORCE-DRAIN any buffered rename signals (cancel the debounce, drain NOW) before sampling
    // idle, so a flush/convergence pass never acts on the half-state (old path live, file gone). The
    // buffering itself is async (a source awaits `base.load`) and tracked in `inflight`, so we MUST
    // drain `inflight` FIRST (let the source land in the buffer), THEN force-drain — otherwise the
    // drain could run with a half-populated buffer (a target but not yet its matching source) and
    // mis-route them. The drain is single-flight + tracked in `inflight`, so its own fallout
    // (onWrite/onDelete) is awaited by the loop too. Loop until both are fully quiescent.
    for (;;) {
      while (this.inflight.size > 0) {
        await Promise.allSettled([...this.inflight]);
      }
      if (
        this.renameBuf.sources.size === 0 &&
        this.renameBuf.targets.size === 0 &&
        this.renameBuf.draining === null
      ) {
        return;
      }
      await this.runRenameDrain();
    }
  }

  /**
   * The user confirmed a held closed-app delete (a `pending-delete` inbox entry). Tombstone with the
   * CONFIRMED-on-disk hash (materializedHash), remove the materialized-back file, and resolve the
   * entry. The removal's delete event hits {@link onDelete}, which early-returns on the now-tombstoned
   * entry. Idempotent: a no-op (just resolve) if the entry is already gone/tombstoned.
   */
  async confirmPendingDelete(path: VaultPath): Promise<void> {
    const entry = this.index.get(path);
    if (entry === undefined || entry.deleted === true) {
      this.resolvePendingDeleteInbox(path);
      return;
    }
    const rec = await this.base.load(entry.docId);
    // Re-read after the await: a concurrent confirm may have already tombstoned + deleted the base.
    // Tombstone ONLY with the confirmed-on-disk materializedHash — NEVER a fileHash/empty fallback, which
    // could overwrite a correct tombstone with a hash peers don't match and make them RESURRECT.
    const current = this.index.get(path);
    if (current === undefined || current.deleted === true || rec?.materializedHash === undefined) {
      this.resolvePendingDeleteInbox(path);
      return;
    }
    await this.tombstoneAndCleanup(path, current.docId, current.type, rec.materializedHash);
    await this.ports.vault.remove(path);
    this.resolvePendingDeleteInbox(path);
  }

  /**
   * The user chose to KEEP a held closed-app delete: leave the (materialized-back) file + clear the
   * inbox entry. The next bootstrap re-confirms materializedHash for the present file.
   */
  dismissPendingDelete(path: VaultPath): Promise<void> {
    this.resolvePendingDeleteInbox(path);
    return Promise.resolve();
  }

  private resolvePendingDeleteInbox(path: VaultPath): void {
    for (const e of this.inbox.list()) {
      if (e.kind === "pending-delete" && e.path === path) this.inbox.resolve(e.id);
    }
  }

  /**
   * Resolve a CONTENT conflict (kind `conflict`/`supervised-import` carrying an `artifactPath`):
   * `keep-current` discards the backup; `keep-backup` adopts the backup as the live note. Both
   * then tombstone the inbox entry. Idempotent/re-entrant (safe on double-click). Throws
   * {@link ArtifactNotLocalError} on a device where the backup file is absent (a non-authoring
   * peer) — the caller offers acknowledge-only there. NOT for pending-delete/resurrected/notice
   * entries (use confirmPendingDelete/dismissPendingDelete/inbox.resolve).
   */
  async resolveContentConflict(id: string, action: ResolveAction): Promise<void> {
    const entry = this.inbox.list().find((e) => e.id === id);
    if (entry === undefined) return; // unknown / already resolved — idempotent no-op
    if (
      entry.artifactPath === undefined ||
      (entry.kind !== "conflict" && entry.kind !== "supervised-import")
    ) {
      throw new Error(`resolveContentConflict: ${id} is not a content conflict`);
    }
    const artifactPath = entry.artifactPath;
    if (artifactPath === entry.path) {
      throw new Error(
        `resolveContentConflict: ${id} artifactPath equals the live path (malformed entry)`,
      );
    }
    const bytes = await this.ports.vault.read(artifactPath);
    if (bytes === null) throw new ArtifactNotLocalError(artifactPath);

    if (action === "keep-backup") {
      const doc = await this.ensureNoteAttached(entry.path);
      if (doc === undefined) {
        throw new Error(`resolveContentConflict: live doc for ${entry.path} unavailable`);
      }
      const backupText = canonicalizeProse(decode(bytes));
      const crdtText = doc.getText();
      if (backupText !== crdtText) {
        doc.applyEdits(diffToEdits(crdtText, backupText), "local-bridge");
      }
      await this.adoptBackupIntoLive(doc, entry.path, backupText);
    }
    await this.deleteConflictArtifact(artifactPath);
    this.inbox.resolve(id);
  }

  /**
   * Delete a resolved conflict's backup artifact SAFELY. The common emitConflict/supervised-import
   * artifact is UNBOUND (a bare disk file, no index entry) → a plain local remove. A bound artifact
   * (e.g. after a bootstrap seed re-bound it) is tombstoned with the SAME materializedHash-guarded
   * discipline as {@link confirmPendingDelete} — never a fallback hash, or a peer that edited it
   * would RESURRECT it. If a bound artifact has no confirmed materializedHash yet, leave the file
   * (byte-safe) rather than lay an unsafe tombstone.
   */
  private async deleteConflictArtifact(artifactPath: VaultPath): Promise<void> {
    const entry = this.index.get(artifactPath);
    if (entry === undefined || entry.deleted === true) {
      this.echo.clear(artifactPath);
      await this.ports.vault.remove(artifactPath);
      return;
    }
    const rec = await this.base.load(entry.docId);
    const cur = this.index.get(artifactPath); // re-read after the await (concurrent resolve)
    if (cur === undefined || cur.deleted === true) return;
    if (rec?.materializedHash === undefined) return; // cannot tombstone safely → leave the file
    await this.tombstoneAndCleanup(artifactPath, cur.docId, cur.type, rec.materializedHash);
    await this.ports.vault.remove(artifactPath);
  }

  /**
   * Adopt `backupText` (already applied to `doc`'s CRDT by the caller) as the live note at `path`,
   * converging disk + base + index (+ relay, automatic via the transport). A PURE overwrite: unlike
   * reconcileDirtyDoc it does NOT merge the current disk — "keep backup" DISCARDS the live winner, so
   * the doc's text is authoritative. Mirrors the base-before-file + lagging-acked + dirty-before-base
   * discipline of ingest/outbound.
   */
  private async adoptBackupIntoLive(
    doc: CrdtDoc,
    path: VaultPath,
    backupText: string,
  ): Promise<void> {
    const newHash = await sha256OfText(backupText);
    const prior = await this.base.load(doc.id);
    // dirty BEFORE base (crash-ordering): never leave the base advanced-but-not-dirty (a wedge).
    await this.ports.engineState.markDirty(doc.id);
    // base BEFORE file (torn-pair). Keep the acked/recovery base LAGGING — this push is not yet acked.
    await this.base.save(doc.id, {
      baseText: backupText,
      fileHash: newHash,
      crdtToken: doc.encodeStateVector(),
      substrate: this.substrate,
      ackedText: prior?.ackedText ?? "",
      ackedHash: prior?.ackedHash ?? (await sha256OfText("")),
      materializedHash: newHash,
    });
    // keep-backup is a DELIBERATE overwrite: always materialize the backup to disk (echo-guarded),
    // EVEN when the note is active-bound. applyEdits already set the editor's Y.Text to the backup, so
    // disk == the editor buffer (no divergence/loss). Writing now — rather than deferring to the
    // editor's autosave — closes a window where a reconcileDirtyDoc firing pre-autosave would compute
    // merge3(acked, disk=winner, crdt=backup) and re-introduce the discarded winner (when the winner
    // was an unpushed local edit). The editor stays bound to the Y.Text, so this cannot lose edits.
    this.echo.recordWrite(path, newHash);
    await this.ports.vault.writeAtomic(path, utf8(backupText));
    await this.ports.docStore.save(doc.id, doc.encodeSnapshot());
    // Bump the index tree stamp so peers converge on the adopted content (the seam ingest uses).
    this.scheduleBump(path, doc.id, "crdt-prose", newHash);
  }

  /**
   * M2 engine-mediated rename guard (refuse-before-move). Before physically moving the file, REFUSE a
   * rename whose target is an OCCUPIED live path bound to a DIFFERENT docId — the OS move would clobber
   * the occupant's bytes and lose content. Surfaces one inbox notice and does NOT move. Returns true if
   * the rename proceeded, false if refused. (External renames bypass this entirely — they arrive as
   * delete+create through the watcher and are handled by the bootstrap displacement detector.)
   */
  async requestRename(from: VaultPath, to: VaultPath): Promise<boolean> {
    const fromEntry = this.index.get(from);
    const toEntry = this.index.get(to);
    // Refuse a DIRECTORY rename: requestRename is single-path only (its synthetic `rename` no-ops in
    // onRename when `from` has no entry). A dir move must arrive via the external-mv path (dir-delete
    // expansion). Subtree-rename-via-requestRename is the deferred plugin path (G).
    if (this.liveChildrenUnder(from).length > 0) {
      this.inbox.add({
        id: `conflict:rename-refused:${to}`,
        kind: "conflict",
        path: to,
        detail: `Rename of ${from} to ${to} was refused: ${from} is a folder.`,
      });
      return false;
    }
    // M3: refuse a rename whose target is a BUFFERED rename target. The target is physically present
    // (an external write the coalescer is still reconciling) but intentionally still unbound, so the
    // index-only guard below would not catch it — and `vault.rename` would clobber the buffered file's
    // bytes before the matcher reads them (data loss). `drainingTargets` extends this to a target a drain
    // has snapshotted-but-not-yet-read (F2): the snapshot clears `targets`, so without it a requestRename
    // landing mid-drain would slip past and clobber. Surface one notice and do NOT move. NOTE: we
    // intentionally guard only the TARGET (the dangerous, clobbering side); a buffered SOURCE `from` is
    // a benign no-op rename of an already-gone file, so it needs no guard here.
    if (this.renameBuf.targets.has(to) || this.renameBuf.drainingTargets.has(to)) {
      this.inbox.add({
        id: `conflict:rename-refused:${to}`,
        kind: "conflict",
        path: to,
        detail: `Rename of ${from} to ${to} was refused: an external file is being reconciled there.`,
      });
      return false;
    }
    if (toEntry !== undefined && toEntry.deleted !== true && toEntry.docId !== fromEntry?.docId) {
      this.inbox.add({
        id: `conflict:rename-refused:${to}`,
        kind: "conflict",
        path: to,
        detail: `Rename of ${from} to ${to} was refused: ${to} already exists.`,
      });
      return false;
    }
    await this.ports.vault.rename(from, to);
    return true;
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
    // OPEN RENAME TRANSACTION (0b-3): a rename whose bounded settle window has not yet
    // fired is in-flight — quiescence must wait so `waitConverged` does not declare
    // convergence while the watcher's async fallout is still quarantined (and before the
    // settle reconcile has proven the renamed file is on disk). The transaction carries a
    // DocId, so it names the in-flight rename in a stuck dump; once the settle fires it
    // closes and this clears. READ-ONLY: reads the transaction bookkeeping only.
    for (const txn of this.renameTxn.openTransactions()) pending.add(txn.docId);
    // M3 LIVE-RENAME BUFFER: a buffered rename signal leaves the index inconsistent with disk (a
    // source: old path live, file gone; a target: file present, unbound) — quiescence must not pass
    // until the window drains. A source carries the doc's real docId; a target carries none yet, so add
    // a stable DIAGNOSTIC token (`rename-target:<path>`) — pendingDocs is consumed only by `.length`/
    // `.join` (count + the waitConverged stuck-dump), never resolved back to a doc. At steady state the
    // buffer is EMPTY (whenIdle force-drains it before any sample), so this never wedges convergence.
    for (const [, s] of this.renameBuf.sources) pending.add(s.docId);
    for (const t of this.renameBuf.targets) pending.add(`rename-target:${t}` as DocId);
    return [...pending];
  }

  /**
   * READ-ONLY snapshot of the blob manifest (the index `blobs` map), via the
   * {@link BlobEngine}. A pure manifest snapshot for tests / the blob-state surface —
   * NO LONGER consumed by {@link pendingDocs} (blobs were decoupled from prose
   * convergence; the background queue is the sole eager materialize driver). PURE READ —
   * never mutates the manifest, so it is safe on the convergence loop.
   */
  blobManifestEntries(): [VaultPath, BlobManifestEntry][] {
    return this.blobEngine.manifestEntries();
  }

  /**
   * ONE aggregate inbox item for ALL parked blob failures (never per-path spam). Called by the
   * BlobFetchQueue whenever its parked-failure set changes. Empty set => resolve (tombstone) it.
   */
  private surfaceBlobFailures(paths: VaultPath[]): void {
    const [first] = paths;
    if (first === undefined) {
      this.inbox.resolve("blob:sync-failed");
      return;
    }
    const sample = paths.slice(0, 3).join(", ");
    this.inbox.add({
      id: "blob:sync-failed",
      kind: "conflict",
      path: first,
      detail: `${String(paths.length)} file(s) could not sync (e.g. ${sample}). Will retry.`,
    });
  }

  /** Background blob fetch progress (materialized / total advertised / parked-failed). */
  blobProgress(): { materialized: number; total: number; failed: number } {
    return this.blobEngine.blobProgress();
  }

  /** True once every advertised blob is materialized-or-parked (no queued/in-flight/retry). */
  blobsSettled(): boolean {
    return this.blobEngine.blobsSettled();
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
      // S7: recover ORPHANS (concurrent-create losers) before the convergence check. They are NOT
      // live entries and are in NO backstop set, so pendingDocs + the backstop sets cannot represent
      // an un-recovered orphan — and S7 moved the sweep OUT of the scoped hot path, so without this
      // the check below could falsely report convergence with a loser still stranded in the docStore.
      // We run ONLY the sweep here (NOT a full catch-up pass): the sweep is idempotent + loop-safe and
      // does NOT advance synced stamps, so it cannot disturb an active-bound doc whose index is still
      // pre-merge (running a full catch-up here WOULD — it advances the synced stamp to the editor's
      // merged text while the index lags, latching a false mismatch). If the sweep recovers a loser,
      // the new conflict artifact is a live entry → pendingDocs becomes non-empty → the check below
      // does not return, and the runFullConvergencePass below materializes the artifact to disk.
      // COST: the per-candidate docStore.load is gated behind a non-empty orphan set, so the common
      // no-orphan case is just one docStore.list() + an in-memory diff — lower-order than the
      // pendingDocs() disk scan already on this gate. SAFE before catch-up: orphan discrimination keys
      // off the index TREE BINDING (which converges via ingest independently of catch-up's synced-
      // stamp/attach work). Idempotent, so the redundant sweep inside runFullConvergencePass (and the
      // S6c audit) is harmless.
      await this.runOrphanSweep();
      await this.whenIdle();
      // S6a: do not return while backstop work remains (the sets may hold docIds that have not yet
      // been given a draining pass — returning early would falsely report convergence). Check all
      // three backstop sets in addition to pendingDocs.
      if (
        (await this.pendingDocs()).length === 0 &&
        this.pendingDivergenceDocIds.size === 0 &&
        this.lazyAttach.needsCatchUpSnapshot().size === 0 &&
        this.lazyAttach.remoteUpdatedSinceSettleSnapshot().size === 0
      )
        return;
      // Catch-up THEN structural reconcile (mirrors the index-observe chain): the
      // reconcile's materialization step drives a now-live resurrected entry's
      // content to disk, which the disk-aware pendingDocs check waits on.
      // Stage 4a: uses runFullConvergencePass() — the named full-chain entry point.
      // waitConverged MUST always run the FULL chain (never the scoped hot path).
      await this.runFullConvergencePass();
      await this.whenIdle();
      // S6a: same backstop check on the second idle in each round.
      if (
        (await this.pendingDocs()).length === 0 &&
        this.pendingDivergenceDocIds.size === 0 &&
        this.lazyAttach.needsCatchUpSnapshot().size === 0 &&
        this.lazyAttach.remoteUpdatedSinceSettleSnapshot().size === 0
      )
        return;
    }
    const stuck = await this.pendingDocs();
    throw new Error(
      `waitConverged: did not settle after ${String(MAX_ROUNDS)} rounds: ${stuck.join(", ")}`,
    );
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
    if (existing !== undefined) {
      // Already attached (e.g. by the background initial catch-up). Its dirty-reconcile may still
      // be IN FLIGHT; AWAIT it before handing the doc to the editor binding so the Y.Text is FINAL
      // (a disk edit made while the engine was down is merged in) BEFORE ySync starts tracking.
      // Otherwise a reconcile that lands AFTER the binding attaches replays the disk-edit delta into
      // an editor that already shows it → the edit is DUPLICATED (the cold-restart-with-open-note
      // bug surfaced in real Obsidian). Idempotent + offline-safe: no-op unless the doc is dirty, and
      // for an active-bound path the disk write is gated — only the Y.Text merge runs.
      await this.reconcileDirtyDoc(existing);
      return existing;
    }
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
      if (origin !== "remote") return;
      // ACTIVE-BOUND GUARD: when an editor is bound to this doc, the CM6/yCollab binding renders the
      // remote update into the editor LIVE and the host (Obsidian) autosaves it to disk. Materializing
      // here too would write the open file behind the host's back ("modified externally") and race its
      // autosave → spurious 3-way-merge conflicts. So leave disk to the editor while bound; the editor's
      // autosave drives ingest, which reconciles base/stamp (and on unbind the note reconciles normally).
      // Headless/daemon docs are never `active-bound`, so this is a no-op there (harness unchanged).
      const path = this.pathOf(doc.id);
      if (path !== undefined && this.isActiveBound(path)) return;
      // Stage 3: enqueue into remoteUpdatedSinceSettle (after the active-bound guard). O(1); no I/O.
      // For non-active-bound docs this gives settleCleanDocs a trigger for docs that converge via
      // remote note-doc updates with NO index-key change (the clean-settle-latch backstop, Risk #1
      // in the cross-model review). S6a: active-bound docs are excluded — their convergence is driven
      // by the editor's autosave → ingest chain. Enqueueing them here would fire onBackstopWork and
      // trigger extra reconcile passes that advance the synced stamp to the merged CRDT hash while
      // the index stamp is still at the pre-merge value (because the editor edit bypasses ingest),
      // creating a permanent stamp mismatch that keeps waitConverged spinning forever.
      this.lazyAttach.noteRemoteUpdate(doc.id);
      // F2: bump the progress counter — incoming remote note-doc update = relay is delivering work.
      this.reconcileProgressTick++;
      this.track(this.outbound.onRemoteUpdate(doc));
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
    if (!(await this.ports.engineState.isDirty(docId))) return;

    const path = this.pathOf(docId);
    if (path === undefined) return;
    const bytes = await this.ports.vault.read(path);
    if (bytes === null) return; // gone — the delete/tombstone path owns this
    // CANONICAL-LF (#35 + hash-identity): a note CRDT doc is ALWAYS prose, so canonicalize
    // the decoded disk content to LF at this decode boundary before it is merged into the
    // CRDT / hashed-as-text / saved to base / stamped. `rawDiskText` keeps the un-canonicalized
    // form for the disk write-back DIFF only, so a CRLF file is rewritten to LF (the one-time
    // churn through the EXISTING write path). See {@link canonicalizeProse}.
    const rawDiskText = decode(bytes);
    const diskText = canonicalizeProse(rawDiskText);
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
    // S9 first-sync write-fold: skip this base write when it would persist a record that is
    // BEHAVIORALLY IDENTICAL to the one already on disk. Every field of the record below is
    // carried forward from `baseRec` (substrate is constant; ackedText/ackedHash default to
    // baseRec's) EXCEPT `baseText`/`fileHash` — and `crdtToken`, which is WRITE-ONLY: it is
    // serialized but never read back anywhere in production (an 0b-2 §A/§B vestige). So when the
    // merged content already matches the on-disk base (`fileHash === mergedHash`), re-saving here
    // only flips `crdtToken` null->stateVector, which nothing consumes. On a bulk cold seed the
    // bootstrap-seeded base already holds this content for EVERY doc, so this skips ~1/3 of the
    // first-sync base-sidecar writes (the dominant on-device seed cost). SAFE: the on-disk base is
    // already correct, so the torn-pair rule (base reflects content before the file write below)
    // still holds; and a GENUINE merge (crash-recovery / offline-drift) changes fileHash, so a
    // real working-base advance is NEVER skipped.
    if (baseRec?.fileHash !== mergedHash) {
      await this.base.save(docId, {
        baseText: merged,
        fileHash: mergedHash,
        crdtToken: doc.encodeStateVector(),
        substrate: this.substrate,
        ackedText: baseRec?.ackedText ?? "",
        ackedHash: baseRec?.ackedHash ?? (await sha256OfText("")),
        // M1b: preserve the durable confirmed-on-disk signal across a fresh-record save.
        materializedHash: baseRec?.materializedHash,
      });
    }
    // Compare the merge result against the RAW (un-canonicalized) disk text so a CRLF file
    // whose canonical content already equals `merged` (LF) is still rewritten to LF — the
    // one-time canonical-LF churn (#35 + hash-identity).
    // ACTIVE-BOUND: skip the disk write — the open editor + host autosave own this file (writing here
    // races the autosave → "modified externally"). The merge/base/dirty bookkeeping above still runs, so
    // the edit is tracked + pushed via the provider; disk is reconciled by the autosave + on unbind.
    if (merged !== rawDiskText && !this.isActiveBound(path)) {
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
    // F4: count each ack-confirmed convergence as progress so the watchdog does not mis-fire
    // during the ack-tail (relay acking pushes one-by-one). Each acked doc advances the tick
    // synchronously (before awaits) → the watchdog re-arms without auditing → O(n^2) tail
    // audits collapse to at most a handful. O(1) increment; does not change convergence logic.
    this.reconcileProgressTick++;
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
      // M1b: a fresh-record save must PRESERVE materializedHash (the durable confirmed-on-disk
      // signal). Without carrying it forward, the post-bootstrap ack-flush would clobber the
      // value the bootstrap observe just recorded.
      materializedHash: prior?.materializedHash,
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
  private async structuralReconcile(scope?: {
    workset: ReadonlySet<DocId>;
    liveByDocId: ReadonlyMap<DocId, VaultPath[]>;
    allByDocId: ReadonlyMap<DocId, VaultPath[]>;
  }): Promise<void> {
    // STABILITY GATE bookkeeping (torn-rename race): record THIS pass's divergence
    // signatures while confirming against the PRIOR pass; swap in after the pass so the
    // NEXT pass can confirm. A divergence resolves only when seen on two consecutive passes.
    const currentDivergence = new Map<DocId, string>();
    // Stage 3: track which docIds this structural pass invokes confirmDivergence on (>1 live
    // paths). Any docId seen with >1 live paths is: resolved (confirmed) → drain
    // pendingDivergenceDocIds; or unresolved → enqueue into pendingDivergenceDocIds.
    // After the pass, any pendingDivergenceDocIds NOT seen with >1 live paths (<=1 live path)
    // are drained — the divergence dissolved or the entry was deleted.
    const divergentThisPass = new Set<DocId>();
    const confirmDivergence = (docId: DocId, livePaths: VaultPath[]): boolean => {
      const sig = [...livePaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\u0000");
      currentDivergence.set(docId, sig);
      divergentThisPass.add(docId);
      const confirmed = this.priorDivergence.get(docId) === sig;
      // Stage 3 drain discipline (cross-model review item 4): we do NOT drain
      // pendingDivergenceDocIds on CONFIRM. Even when confirmed, the docId still has >1 live paths
      // right now and applyRenameConflictResolution + the post-check have not run. The post-pass
      // drain loop below (removes docIds NOT in divergentThisPass, i.e. observed with <=1 live
      // path) is the SOLE drain — one extra pass of latency, correct + safe for S4+. On a
      // NOT-yet-confirmed sighting, ENQUEUE so the next structural pass revisits this docId even
      // if no changed path selects it (Risk #3; the stability gate awaits a 2nd consecutive sighting).
      // S6a: use enqueuePendingDivergenceDocId so the self-draining flag + schedule fires only on
      // a genuinely-new enqueue (anti-spin: a stability-gate re-sighting on a docId already in the
      // set does NOT set freshBackstopWork again).
      if (!confirmed) {
        this.enqueuePendingDivergenceDocId(docId);
      }
      return confirmed;
    };
    await runStructuralReconcile({
      index: this.index,
      vault: this.ports.vault,
      localHashOf: async (path) => {
        const bytes = await this.ports.vault.read(path);
        return bytes === null ? null : await sha256OfBytes(bytes);
      },
      markDirty: (docId) => this.ports.engineState.markDirty(docId),
      markDeleted: (docId) => this.ports.engineState.markDeleted(docId),
      deleteBase: (docId) => this.base.delete(docId),
      deleteSnapshot: (docId) => this.ports.docStore.delete(docId),
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
      // S5: thread the workset scope when present (observe-driven path only).
      // scope === undefined (full path) ⇒ byte-for-byte unchanged behavior.
      // Use spread to omit the property entirely when unscoped (exactOptionalPropertyTypes).
      ...(scope !== undefined
        ? { scope: { workset: scope.workset, allByDocId: scope.allByDocId } }
        : {}),
    });
    this.priorDivergence = currentDivergence;

    // Stage 3: DRAIN pendingDivergenceDocIds of any docId that was NOT seen with >1 live paths
    // this pass — it now has <=1 live path (non-divergent, dissolved torn rename, or deleted).
    for (const docId of this.pendingDivergenceDocIds) {
      if (!divergentThisPass.has(docId)) {
        this.pendingDivergenceDocIds.delete(docId);
      }
    }

    // Materialize any LIVE entry whose attached doc carries content the local disk
    // does not yet reflect. This closes a cross-doc ORDERING race in the C3
    // resurrection: a receiving device (no local file — its resurrect pass is a
    // no-op) gets the note-doc's resurrected content AND the index's now-live entry
    // as TWO independent CRDT docs. If the note update is applied while the index is
    // still tombstoned, outbound's `pathOf` finds no live path and skips the disk
    // write — yet catch-up still records the synced stamp, so the device would
    // report quiescence with an EMPTY file. Re-driving the (idempotent, echo-guarded)
    // outbound reconcile once the entry is live guarantees the content reaches disk.
    await this.materializeLiveDiskContent(scope);

    // S7: orphan sweep is cross-docStore work — a concurrent-create loser's docId is NOT
    // in the changed-docId closure (only the winner's path got bound in the index), so it
    // is NOT workset-scopable. Running it per scoped pass would be O(docStore) per pass →
    // O(n^2) over the ~n-pass seed storm. It runs ONLY in full passes (startup /
    // waitConverged / the S6c low-frequency quiescence audit via runFullConvergencePass),
    // which recover concurrent-create losers at quiescence. A loser that surfaces during
    // scoped passes stays in its docStore snapshot and is recovered at the next full pass
    // (the S6c audit fires ~AUDIT_QUIESCENCE_MS after the collision settles, or the
    // watchdog, or waitConverged, or a restart). NEVER drop this call from the full path.
    if (scope === undefined) {
      await this.runOrphanSweep();
    }
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
  private async materializeLiveDiskContent(scope?: {
    workset: ReadonlySet<DocId>;
    liveByDocId: ReadonlyMap<DocId, VaultPath[]>;
  }): Promise<void> {
    const deviceId = this.ports.identity.deviceId();
    // Load the dirty set ONCE before the loop (was re-read per live entry; behavior-identical).
    // A Set, not the array, so the per-entry membership check below is O(1) not O(n) (else the
    // loop is O(n^2) over a large live index).
    const dirty = new Set(await this.ports.engineState.listDirty());

    if (scope !== undefined) {
      // SCOPED PATH (S4c): iterate only the workset docIds, expanding each to its live paths via
      // liveByDocId. Every per-entry gate is IDENTICAL to the full path — only WHICH entries are
      // visited changes. scope === undefined ⇒ the FULL path below (byte-for-byte unchanged).
      // INVARIANT: the per-entry guard chain below MUST stay identical to the FULL path's chain
      // (see the loop at "FULL PATH" below). Any guard edit must be applied to BOTH branches —
      // a divergence is a silent clobber-class data-loss bug (the fuzzer + Scenario 13/14 guard it).
      for (const docId of scope.workset) {
        for (const path of scope.liveByDocId.get(docId) ?? []) {
          const entry = this.index.get(path);
          // Defensive guards: entry must exist and must be live (not tombstoned).
          if (entry === undefined || entry.deleted === true) continue;

          const doc = this.attached.get(entry.docId);
          if (doc === undefined) continue;

          // ACTIVE-BOUND: an open editor owns this file's disk — the CM/yCollab binding renders the
          // converged content live and the host (Obsidian) autosaves it. Materializing here races
          // that autosave (disk is briefly "behind" the just-typed CRDT) and trips the host's
          // "modified externally" auto-merge. Skip; disk reconciles via autosave (ingest) and unbind.
          if (this.isActiveBound(path)) continue;

          const docStamp = makeStamp(await sha256OfText(doc.getText()), deviceId);
          if (!stampsEqual(docStamp, entry.stamp)) continue; // CRDT not yet at the indexed content.

          const bytes = await this.ports.vault.read(path);
          const diskStamp = bytes === null ? null : makeStamp(await sha256OfBytes(bytes), deviceId);
          if (stampsEqual(diskStamp, entry.stamp)) continue; // disk already canonical.

          // ANTI-CLOBBER GUARD: only write when the disk is provably NOT a newer un-ingested
          // external edit — either BEHIND the converged doc, or a relocated concurrent-create
          // sibling. The decision lives in the SHARED safeToOverwriteStaleLive helper (the full
          // branch below calls the SAME one), so the scoped + full guards CANNOT diverge — the old
          // duplicated-guard hazard is structurally eliminated.
          if (
            bytes !== null &&
            !(await this.safeToOverwriteStaleLive(path, entry.docId, bytes, dirty))
          )
            continue;

          if (bytes === null && this.shouldDeferMissingLive(path)) continue; // BARRIER (Part B)
          await this.outbound.onRemoteUpdate(doc);
        }
      }
      return;
    }

    // FULL PATH (scope === undefined): byte-for-byte identical to the pre-S4c implementation.
    // Used by runFullConvergencePass (startup/waitConverged), the rename-fallout handler, and
    // any future periodic audit. NEVER change this branch as part of S4c.
    for (const [path, entry] of this.index.liveEntries()) {
      const doc = this.attached.get(entry.docId);
      if (doc === undefined) continue;

      // ACTIVE-BOUND: an open editor owns this file's disk — the CM/yCollab binding renders the
      // converged content live and the host (Obsidian) autosaves it. Materializing here races that
      // autosave (disk is briefly "behind" the just-typed CRDT) and trips the host's "modified
      // externally" auto-merge. Skip; disk reconciles via the editor's autosave (ingest) and on unbind.
      if (this.isActiveBound(path)) continue;

      const docStamp = makeStamp(await sha256OfText(doc.getText()), deviceId);
      if (!stampsEqual(docStamp, entry.stamp)) continue; // CRDT not yet at the indexed content.

      const bytes = await this.ports.vault.read(path);
      const diskStamp = bytes === null ? null : makeStamp(await sha256OfBytes(bytes), deviceId);
      if (stampsEqual(diskStamp, entry.stamp)) continue; // disk already canonical.

      // ANTI-CLOBBER GUARD: only write when the disk is provably NOT a newer un-ingested external
      // edit — either BEHIND the converged doc, or a relocated concurrent-create sibling. The
      // decision lives in the SHARED safeToOverwriteStaleLive helper (the scoped branch above calls
      // the SAME one), so the scoped + full guards CANNOT diverge — the old duplicated-guard hazard
      // is structurally eliminated.
      if (bytes !== null && !(await this.safeToOverwriteStaleLive(path, entry.docId, bytes, dirty)))
        continue;

      if (bytes === null && this.shouldDeferMissingLive(path)) continue; // BARRIER (Part B)
      await this.outbound.onRemoteUpdate(doc);
    }
  }

  /**
   * ANTI-CLOBBER decision for {@link materializeLiveDiskContent} — called IDENTICALLY from the
   * scoped and full branches (a divergence here is a silent clobber-class data-loss bug). May we
   * overwrite an EXISTING live file whose disk bytes differ from the converged doc, with the
   * converged content?
   *
   * True ONLY when the disk is provably NOT a newer un-ingested EXTERNAL edit:
   *   - NEVER over a DIRTY doc — its disk may hold an unpushed (post-crash recovered) edit.
   *   - disk == the doc's last-reconciled working base (`base.fileHash`) ⇒ genuinely BEHIND ⇒ write.
   *   - else the disk bytes are a RELOCATED concurrent-create SIBLING (the recovered LWW loser of
   *     THIS path, now materialized at its conflict artifact) ⇒ not unique disk state ⇒ write. This
   *     is the concurrent-create split-brain fix: on the reconnecting device the live disk can hold
   *     the loser's bytes (its own losing create, or a transiently-materialized remote loser) whose
   *     hash never equals the WINNER's `base.fileHash`, so the old base-only guard skipped forever.
   *   - otherwise (a genuine external edit, or unprovable) ⇒ SKIP. Ingest reconciles it; the
   *     `pendingDocs` disk-hash clause keeps `waitConverged` looping so a skip never masks a loss.
   */
  private async safeToOverwriteStaleLive(
    path: VaultPath,
    docId: DocId,
    bytes: Uint8Array,
    dirty: ReadonlySet<DocId>,
  ): Promise<boolean> {
    if (dirty.has(docId)) return false;
    const diskHash = await sha256OfBytes(bytes);
    const base = await this.base.load(docId);
    if (diskHash === base?.fileHash) return true;
    return this.diskIsRelocatedSibling(path, docId, diskHash);
  }

  /**
   * A+ relocated concurrent-create SIBLING proof. True when `diskHash` (the stale bytes at live
   * `currentPath`, bound to `currentDocId`) equals — byte-for-byte ON THIS DISK — the content of a
   * DIFFERENT live doc that is the recovered LWW loser of THIS path: a live entry whose create-meta
   * `originalPath === currentPath` and whose path is exactly its deterministic
   * {@link orphanRecoveryPath}. Those bytes therefore still survive in a user-visible file, so
   * re-materializing the winner over them loses NOTHING.
   *
   * The sibling DISK read is LOAD-BEARING: index state alone does not prove the duplicate bytes are
   * present locally (a note-doc's content and the index entry that binds it can arrive
   * independently). If the conflict file is not yet materialized, we SKIP and repair on a later pass
   * once it is — never removing the only on-disk copy.
   *
   * LIVENESS (honest guarantee): the repair lands on the NEXT full pass that runs AFTER the conflict
   * sibling is materialized on this disk — prompt via `/sync/flush`→`waitConverged` (the harness gate
   * proves this), startup, or a true idle window's S6c audit; NOT hard-bounded under sustained
   * unrelated churn (the progress-aware watchdog re-arms while activity advances). This is byte-safe
   * throughout (both bodies always survive — the loser at its conflict artifact) and is the same
   * full-pass-only liveness-exposure class as the adjacent {@link runOrphanSweep}.
   *
   * PERF: the per-entry `loadCreateMeta` (docStore load + parse) + disk read run ONLY for conflict
   * artifacts — `orphanRecoveryPath` (= `conflictArtifactPath`) ALWAYS emits the literal `"(conflict,"`
   * suffix, so the cheap in-memory path pre-filter below is a behavior-preserving SUPERSET that bounds
   * the I/O to the (typically 0–2) artifacts in the vault, not all N live entries.
   */
  private async diskIsRelocatedSibling(
    currentPath: VaultPath,
    currentDocId: DocId,
    diskHash: Sha256,
  ): Promise<boolean> {
    for (const [otherPath, otherEntry] of this.index.liveEntries()) {
      if (otherEntry.docId === currentDocId) continue;
      if (otherPath === currentPath) continue;
      if (!otherPath.includes("(conflict,")) continue; // cheap superset pre-filter (no I/O)
      const meta = await this.loadCreateMeta(otherEntry.docId);
      if (meta === undefined) continue;
      if (meta.originalPath !== currentPath) continue;
      if (orphanRecoveryPath(meta) !== otherPath) continue;
      const otherBytes = await this.ports.vault.read(otherPath);
      if (otherBytes === null) continue;
      if ((await sha256OfBytes(otherBytes)) !== diskHash) continue;
      return true;
    }
    return false;
  }

  /** Barrier (Part B): should `materializeLiveDiskContent` DEFER re-creating this live+disk-absent path? */
  private shouldDeferMissingLive(path: VaultPath): boolean {
    // Clause 1: owned as a rename source in ANY phase (pending base.load / buffered / draining). The drain
    // re-keys it; re-materializing here would recreate the source (signal destruction + duplication).
    // NOTE: if bufferRenameSource's base.load returns null it routes to onDelete (not a rename) and the
    // path leaves pendingSourcePaths -> the barrier intentionally does not cover that non-rename path.
    // A blanket "clause 2" first-observation grace (defer EVERY live+disk-absent materialize) was
    // considered and DROPPED: it broke the M2 displacement detector, which needs a PROMPT
    // materialize-to-disk to observe a delete-then-reuse collision. The pre-buffer race it would have
    // covered is a documented residual (rare concurrent trigger in the ~20ms watcher-coalesce window).
    return (
      this.renameBuf.pendingSourcePaths.has(path) ||
      this.renameBuf.sources.has(path) ||
      this.renameBuf.drainingSources.has(path)
    );
  }

  /** Add a fire-and-forget promise to the inflight set; auto-remove on settle. */
  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => {
      this.inflight.delete(p);
    });
  }

  /**
   * F2: whether the scoped-pass backstop sets contain outstanding sync work.
   *
   * Returns `true` if ANY of the scoped-path backstop sets are non-empty. Used as the gate
   * for the quiescence audit: if outstanding work is present in the backstop sets, the scoped
   * passes will handle it on the next iteration — the full audit is unnecessary right now.
   * When all sets are empty the engine has processed everything the scoped path can handle,
   * and the quiescence audit's safety check (orphan sweep, disk-only-change detection) is warranted.
   *
   * NOTE: intentionally does NOT gate on the dirty set. Orphaned docs (e.g. the loser docId in a
   * LWW collision) stay dirty indefinitely because no scoped pass ever catches them up —
   * gating on dirty would permanently suppress the quiescence audit, preventing the full pass's
   * orphan sweep from ever running. Dirty docs that CAN be handled by scoped passes manifest as
   * `needsCatchUp` entries; those ARE included here.
   *
   * All checks are O(1) — in-memory set sizes, no I/O.
   */
  private hasOutstandingWork(): boolean {
    if (this.lazyAttach.needsCatchUpSnapshot().size > 0) return true;
    if (this.lazyAttach.remoteUpdatedSinceSettleSnapshot().size > 0) return true;
    if (this.pendingDivergenceDocIds.size > 0) return true;
    return false;
  }

  /**
   * F2: arm (or re-arm) the watchdog stale timer with a snapshotted progress tick.
   *
   * When the timer fires:
   *   - If `reconcileProgressTick` advanced since `tickAtArm` → system is PROGRESSING
   *     (healthy seed, not stuck) → suppress the audit; re-arm for another window.
   *   - If the tick is unchanged → system is STALLED → fire the audit (safety floor).
   *
   * The `auditedThisBusyEpoch` one-shot latch is preserved: once an audit fires in the
   * current epoch the latch is set, and neither this callback nor a re-arm fires again.
   * The epoch ends when the quiescence timer fires (resets the latch).
   *
   * Re-arms are unbounded while the system keeps progressing; they stop when:
   *   (a) the epoch ends (quiescence), OR
   *   (b) a stall is detected (audit fires), OR
   *   (c) the latch is already set (a prior stall fired the audit).
   *
   * NOTE: only called from {@link scheduleReconcile} (initial arm) and from within
   * the timer callback itself (re-arm on progress). Sets `auditStaleTimer` directly.
   */
  private armWatchdogTimer(tickAtArm: number): void {
    this.auditStaleTimer = setTimeout(() => {
      this.auditStaleTimer = null;
      if (this.auditedThisBusyEpoch) return; // latch already set — do nothing
      if (this.reconcileProgressTick !== tickAtArm) {
        // F2: tick advanced — system is making progress (healthy seed). Suppress the audit
        // and re-arm for another window with the updated tick snapshot. The epoch continues.
        this.armWatchdogTimer(this.reconcileProgressTick);
      } else {
        // Tick unchanged — system is genuinely STALLED. Fire the one-shot watchdog audit.
        this.auditedThisBusyEpoch = true;
        this.auditRequested = true;
        // Cancel any pending quiescence timer so a quiescence audit does NOT fire a SECOND
        // full pass right after this watchdog audit when the storm ends.
        if (this.auditQuiescenceTimer !== null) {
          clearTimeout(this.auditQuiescenceTimer);
          this.auditQuiescenceTimer = null;
        }
        // NOTE: this scheduleReconcile is INTENTIONALLY not gated by inFullConvergencePass
        // (unlike the onBackstopWork seam) — the audit wake-up must fire even mid-full-pass.
        this.scheduleReconcile();
      }
    }, AUDIT_MAX_STALENESS_MS);
  }

  /**
   * SCHEDULE the durable work-queue reconcile loop (Stage 2 replacement for the boolean coalescer).
   *
   * If the loop is already running, there is nothing to do: the running iteration will check
   * pendingChangedPaths at the top of its next iteration and pick up the newly added paths.
   * If the loop is not running, schedule it via queueMicrotask (same timing as Stage 1) and
   * track the ACTUAL loop promise so whenIdle/waitConverged await real work.
   *
   * Coalescing property preserved: a burst of observe callbacks all add to pendingChangedPaths
   * before the microtask fires, so they fold into a single first iteration — exactly like the
   * old reconcileAgain flag, but now tracking WHICH paths changed (plumbing for later stages).
   */
  private scheduleReconcile(): void {
    // Loop already running — new paths were added to pendingChangedPaths; the running
    // iteration will drain them at the top of its next while-iteration.
    if (this.reconcileLoopRunning) return;
    // queueMicrotask ensures a burst of synchronous observe callbacks all land in
    // pendingChangedPaths before the loop fires (same timing guarantee as Stage 1).
    this.reconcileLoopRunning = true;

    // S6c / F2: arm the watchdog stale timer when a NEW busy epoch starts (the loop was
    // idle and is now being scheduled). If the stale timer is already armed (from a
    // prior not-yet-fired epoch), do NOT re-arm it — the existing timer is still valid
    // for the ongoing epoch. This ensures one watchdog audit per epoch at most.
    //
    // F2: only arm if there is REAL pending work (index events or backstop work), NOT if
    // the wake-up is audit-only. The quiescence callback calls scheduleReconcile() to
    // wake the audit iteration after explicitly ending the epoch (clearing the watchdog
    // timer and resetting auditedThisBusyEpoch). Without this guard, the audit wake-up
    // would re-arm the watchdog immediately after the quiescence ended the epoch, causing
    // the watchdog to fire AGAIN after AUDIT_MAX_STALENESS_MS — a double-audit.
    //
    // An audit-only wake has: auditRequested=true AND no pendingChangedPaths AND no
    // freshBackstopWork. A genuine new epoch that happens to also have an audit pending
    // will have pendingChangedPaths or freshBackstopWork set (the real work was enqueued
    // before the audit was requested). So the guard is: arm only when real work is pending
    // OR when there is NO audit pending (i.e. this is a genuine new epoch start).
    const isAuditOnlyWake =
      this.auditRequested && this.pendingChangedPaths.size === 0 && !this.freshBackstopWork;
    if (this.auditStaleTimer === null && !this.auditedThisBusyEpoch && !isAuditOnlyWake) {
      this.armWatchdogTimer(this.reconcileProgressTick);
    }

    const loopPromise = new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        void this.runReconcileLoop().then(resolve, reject);
      });
    });
    this.track(loopPromise);
  }

  /**
   * Durable work-queue reconcile loop (Stage 2).
   *
   * Loop while pendingChangedPaths is non-empty:
   *   1. Snapshot-and-drain pendingChangedPaths into runningBatch (the durability boundary —
   *      observe callbacks arriving during the awaits land in pendingChangedPaths, not runningBatch).
   *   2. Run the FULL chain (unchanged — full scans; runningBatch is collected for later stages).
   *   3. SUCCESS: clear runningBatch; continue if pendingChangedPaths grew mid-pass.
   *   4. THROW: re-add runningBatch to pendingChangedPaths (no-work-dropped), stop this loop, and
   *      arm a FRESH loop in the finally (after reconcileLoopRunning is cleared) so the requeued
   *      paths are retried; that retry's tracked promise keeps whenIdle open until it succeeds.
   *
   * The expected failure is handled HERE (re-queue + reschedule), so the loop promise RESOLVES
   * cleanly and {@link track} stays resolve-only — which preserves the unhandled-rejection signal
   * for every OTHER tracked caller (emitConflict, onWrite, etc.). Only an UNEXPECTED throw outside
   * the inner try would reject the loop promise and surface as an unhandled rejection (a real bug).
   *
   * Convergence: post-S6b the observe path is FULLY SCOPED — S4b scopes runCatchUp; S4c scopes
   * materializeLiveDiskContent (via structuralReconcile(scope)); S5 scopes the tombstone/rename/
   * divergent loops; S6b scopes settleCleanDocs. Only runFullConvergencePass remains unscoped.
   */
  private async runReconcileLoop(): Promise<void> {
    let needsReschedule = false;
    try {
      // S6a: loop while there is pending changed-path work OR new backstop work. An empty
      // pendingChangedPaths with freshBackstopWork=true means a docId entered a backstop set
      // with no accompanying index.observe — the flag arms a "backstop-only" pass so that
      // doc is not stranded until the next unrelated index event.
      //
      // S6c: also loop when auditRequested — the quiescence or watchdog audit runs as a special
      // iteration (the full chain), then continues if more work arrived mid-audit.
      //
      // A new observe callback adding to pendingChangedPaths while we await inside the loop is
      // picked up by the NEXT iteration — no extra schedule needed (the loop is already running).
      while (this.pendingChangedPaths.size > 0 || this.freshBackstopWork || this.auditRequested) {
        // S6c: AUDIT ITERATION — checked FIRST, BEFORE any quiescence-timer re-arm.
        // An audit iteration must NOT re-arm the quiescence timer: re-arming here would
        // schedule a fresh AUDIT_QUIESCENCE_MS window after every audit, causing the full
        // convergence pass to repeat indefinitely while the system is idle (a battery/CPU drain
        // that violates the "low-frequency" O(1)-per-quiescence guarantee). Only genuine
        // scoped-pass activity (below) should re-arm the timer.
        if (this.auditRequested) {
          this.auditRequested = false;
          // S6a: consume freshBackstopWork too so we don't spin on backstop-only after the audit.
          // A full convergence pass drains every backstop set, so freshBackstopWork being true
          // at audit time means the full pass will cover it — clearing it here avoids an extra
          // backstop-only loop iteration after the audit completes.
          this.freshBackstopWork = false;
          try {
            await this.runFullConvergencePass();
          } catch {
            // On audit failure: request another audit on next wakeup (do not re-queue a batch —
            // there is no batch for an audit iteration) and stop this loop; the fresh loop retried
            // in the finally will re-run the audit.
            this.auditRequested = true;
            needsReschedule = true;
            break;
          }
          continue;
        }

        // SCOPED-PASS PATH: re-arm the quiescence debounce timer HERE ONLY (genuine activity).
        // Activity is ongoing; only a FULL idle period (no new iterations) lets the timer fire.
        // Clear-then-set ensures the window is always measured from the LAST active iteration.
        // This block is intentionally AFTER the audit-branch so an audit iteration does NOT
        // re-arm the timer (the fix for the repeated-idle-audit bug — S6c).
        if (this.auditQuiescenceTimer !== null) clearTimeout(this.auditQuiescenceTimer);
        this.auditQuiescenceTimer = setTimeout(() => {
          this.auditQuiescenceTimer = null;
          // Quiescence reached: end the busy epoch (reset the watchdog one-shot + stale timer)
          // REGARDLESS of whether we request an audit. Quiescence ending the epoch is
          // unconditional — it just means the loop went idle for the full window.
          if (this.auditStaleTimer !== null) {
            clearTimeout(this.auditStaleTimer);
            this.auditStaleTimer = null;
          }
          this.auditedThisBusyEpoch = false;

          // F2: WORK-AWARE GATE — only request the audit when there is no outstanding work
          // in the scoped-path backstop sets. During an active seed the receiver device has
          // needsCatchUp or remoteUpdatedSinceSettle non-empty between relay round-trips; this
          // correctly suppresses the audit. When all sets are empty the system is genuinely
          // settled from the scoped path's perspective — the full audit's safety check (orphan
          // sweep, disk-only-change detection) is warranted. See hasOutstandingWork() for why the
          // dirty set is intentionally excluded (orphaned dirty docs would permanently block it).
          if (!this.hasOutstandingWork()) {
            // Request the audit and wake the loop (which may have gone idle). Like the watchdog,
            // this scheduleReconcile is INTENTIONALLY not gated by inFullConvergencePass — do not
            // "harmonize" it with the onBackstopWork seam or the audit wake-up could be suppressed.
            this.auditRequested = true;
            this.scheduleReconcile();
          }
          // If outstanding work exists: no audit requested. The scoped passes handle it;
          // the next scoped pass will re-arm the quiescence timer for a fresh window.
        }, AUDIT_QUIESCENCE_MS);

        // S6a: consume the flag at the TOP of the scoped-pass iteration. A new backstop enqueue
        // that fires DURING the awaits below sets freshBackstopWork=true again, causing the loop
        // to continue for one more pass — but ONLY if the re-enqueue is a genuinely-new docId
        // (the anti-spin guard in LazyAttachManager.enqueueNeedsCatchUp /
        // enqueuePendingDivergenceDocId).
        this.freshBackstopWork = false;

        // Snapshot-and-drain: transfer all pending paths into runningBatch. New observe callbacks
        // arriving during the awaits below go into pendingChangedPaths (next iteration) — never into
        // runningBatch. This is the durability boundary. An empty runningBatch (backstop-only pass)
        // is intentional — buildWorksetWithMaps still unions the backstop sets into the workset.
        this.runningBatch = new Set(this.pendingChangedPaths);
        this.pendingChangedPaths.clear();

        try {
          // Stage 4b/4c: compute the docId-closure workset + maps from the running batch + backstop
          // sets, then run the scoped reconcile entry point. The maps are threaded into
          // runObserveScopedReconcile to scope both computeCatchUpSet (S4b: kills the O(n)
          // getSyncedStamp-per-entry scan) and materializeLiveDiskContent (S4c: kills the O(n)
          // vault.read scan — the dominant first-sync read cost).
          // F1: buildWorksetWithMaps no longer calls listDirty() — it is fully synchronous.
          // S6a: an empty runningBatch (backstop-only pass) is fine — buildWorksetWithMaps
          // builds the workset from the backstop unions + open docIds (pure in-memory).
          const worksetBundle = this.buildWorksetWithMaps(this.runningBatch);
          // F2: bump the progress counter when we are about to process a non-empty workset.
          // An empty workset (backstop-only pass on already-drained sets) is a no-op, so only
          // count genuine work to avoid false-progress on spin-idling passes.
          if (worksetBundle.workset.size > 0) this.reconcileProgressTick++;
          await this.runObserveScopedReconcile(worksetBundle);
          // M2: after the pass settles the index for this batch, record the durable lastLivePath for
          // every changed path whose CURRENT index entry is LIVE. This is the runtime maintenance seam
          // for the synchronous onRename (whose re-key flows here via index.observe) and re-records the
          // ingest bind. A tombstoned/absent path is skipped (it is no longer live). Idempotent.
          for (const cp of this.runningBatch) {
            const entry = this.index.get(cp);
            if (entry !== undefined && entry.deleted !== true) {
              await this.noteLiveBinding(entry.docId, cp);
            }
          }
          // Success: clear the running batch. Loop continues if pendingChangedPaths is non-empty
          // OR freshBackstopWork was re-set by a new enqueue that fired during the pass.
          this.runningBatch = new Set();
        } catch {
          // Re-queue the failed batch so no path is dropped, then stop this loop; the fresh loop
          // armed in the finally retries the requeued paths.
          for (const p of this.runningBatch) this.pendingChangedPaths.add(p);
          this.runningBatch = new Set();
          needsReschedule = true;
          break;
        }
      }
    } finally {
      // Always clear the running flag here. On the error path, arm a fresh loop AFTER clearing it so
      // scheduleReconcile sees reconcileLoopRunning === false and starts the retry with a clean flag.
      this.reconcileLoopRunning = false;
      if (needsReschedule) {
        this.scheduleReconcile();
      } else {
        // S6a: close the lost-wakeup race. A scheduleReconcile() that fired WHILE
        // reconcileLoopRunning was still true was a no-op (guard at the top of scheduleReconcile).
        // If new work arrived in that window — either changed paths, fresh backstop work, or a
        // pending audit — we must arm a fresh loop now that the running flag is clear.
        if (this.pendingChangedPaths.size > 0 || this.freshBackstopWork || this.auditRequested) {
          this.scheduleReconcile();
        }
      }
    }
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

  // ── Stage 4a: workset builder + reconcile API split ────────────────────────

  /**
   * Stage 4a: build the set of docIds a scoped pass must process.
   *
   * ALL in-memory, NO I/O. Construction:
   *   1. Iterate the FULL in-memory index to build `liveByDocId` and `allByDocId` (for
   *      use by S4b/c per-PATH expansion at iteration time).
   *   2. For each path in `batch`: resolve docId from `index.get(path)?.docId`, else from
   *      `prevEntryByPath`. Add to the workset.
   *   3. Union backstop sets: `needsCatchUp`, `remoteUpdatedSinceSettle` (via the
   *      LazyAttachManager snapshots), `pendingDivergenceDocIds`, and open docIds.
   *      NOTE (F1): the dirty-set union is intentionally OMITTED.
   *
   * NOTE for S4b/S4c: per-PATH closure (expanding a workset docId to all its live +
   * tombstoned sibling paths) is applied at ITERATION time by the scoped scans; for S4a
   * we only build the docId set and leave `liveByDocId`/`allByDocId` available.
   *
   * BOUNDED: `prevEntryByPath` is pruned of paths that are back in the index (the new
   * index entry supersedes the cache) to prevent unbounded growth.
   *
   * @returns `Set<DocId>` — the workset for the scoped pass.
   */
  buildWorkset(batch: Set<VaultPath>): Set<DocId> {
    return this.buildWorksetWithMaps(batch).workset;
  }

  /**
   * Stage 4a: build the workset AND return the `liveByDocId` / `allByDocId` maps for
   * use by S4b/c scoped scans. This is the canonical implementation; `buildWorkset` is
   * a thin wrapper.
   *
   * Exposed as a PUBLIC test seam so unit tests can inspect the maps. Production passes
   * (S4b/c) will call this directly; tests assert the map contents.
   *
   * F1: the dirty-set union (`listDirty()`) is intentionally OMITTED from the scoped
   * workset. Dirty docs are re-pushed via changed-paths, needsCatchUp, or a FULL pass
   * (startup / reconnect / audit / waitConverged). See the inline comment in Step 3.
   * This function is now fully synchronous (no async I/O at all).
   *
   * noUncheckedIndexedAccess compliance: all Map.get() results are guarded (=== undefined
   * checks or conditional pushes). No `!` non-null assertions are used.
   */
  buildWorksetWithMaps(batch: Set<VaultPath>): {
    workset: Set<DocId>;
    liveByDocId: Map<DocId, VaultPath[]>;
    allByDocId: Map<DocId, VaultPath[]>;
  } {
    // ── Step 1: build liveByDocId and allByDocId from the FULL in-memory index ──
    // Pure iteration — NO vault I/O. Needed at S4b/c iteration time to expand a workset
    // docId to all its live/tombstoned sibling paths.
    const liveByDocId = new Map<DocId, VaultPath[]>();
    const allByDocId = new Map<DocId, VaultPath[]>();

    for (const [p, entry] of this.index.entries()) {
      // Skip the empty-docId sentinel: IndexDoc.delete() lays a { docId: "", deleted: true }
      // placeholder for paths that were observed but never had a real docId assigned. Including
      // the sentinel in the maps would pollute liveByDocId/"" and allByDocId/"" with unresolvable
      // entries and could silently include it in the workset. Filter it here at the source.
      if (entry.docId === "") continue;

      // allByDocId: all entries, including tombstones.
      const allPaths = allByDocId.get(entry.docId);
      if (allPaths === undefined) {
        allByDocId.set(entry.docId, [p]);
      } else {
        allPaths.push(p);
      }

      // liveByDocId: live (non-tombstoned) entries only.
      if (entry.deleted !== true) {
        const livePaths = liveByDocId.get(entry.docId);
        if (livePaths === undefined) {
          liveByDocId.set(entry.docId, [p]);
        } else {
          livePaths.push(p);
        }
      }
    }

    // ── Step 2: resolve docIds for each path in the batch ─────────────────────
    const workset = new Set<DocId>();

    for (const p of batch) {
      // index.get() returns both live and tombstoned entries — docId is preserved on
      // tombstones. Try it first: for a DELETED path the tombstone still has the docId.
      const currentDocId = this.index.get(p)?.docId;
      if (currentDocId !== undefined) {
        // Skip the empty-docId sentinel (IndexDoc.delete() placeholder for never-seen paths).
        if (currentDocId !== "") {
          workset.add(currentDocId);
          // Update prevEntryByPath with the current mapping (keeps cache fresh).
          this.prevEntryByPath.set(p, currentDocId);
        }
      } else {
        // Path completely absent from the index CRDT map (safety net for paths that left the
        // CRDT map entirely — in practice tombstones keep the docId resolvable, so this branch
        // is forward-insurance; prevEntryByPath is the fallback). prevEntryByPath is the safety net.
        const cachedDocId = this.prevEntryByPath.get(p);
        if (cachedDocId !== undefined) {
          workset.add(cachedDocId);
        }
      }
    }

    // BOUNDED pruning: remove prevEntryByPath entries whose path is present in the index
    // (live or tombstoned — the index is authoritative in both cases). Paths completely
    // absent from the index remain in the cache as the fallback for future resolutions.
    for (const [p] of this.prevEntryByPath) {
      if (this.index.get(p) !== undefined) {
        this.prevEntryByPath.delete(p);
      }
    }

    // ── Step 3: union backstop sets (all in-memory, no vault I/O) ─────────────
    // needsCatchUp: docIds whose catch-up did not prove stamp equality.
    for (const docId of this.lazyAttach.needsCatchUpSnapshot()) {
      workset.add(docId);
    }
    // remoteUpdatedSinceSettle: docIds with a pending remote-origin note-doc update.
    for (const docId of this.lazyAttach.remoteUpdatedSinceSettleSnapshot()) {
      workset.add(docId);
    }
    // pendingDivergenceDocIds: docIds with a recorded-but-unresolved divergence.
    for (const docId of this.pendingDivergenceDocIds) {
      workset.add(docId);
    }
    // NOTE (F1): the full listDirty() union is intentionally OMITTED here.
    // A dirty doc is re-pushed via:
    //   (a) changed-path (fresh local edit bumps index → observe → workset), OR
    //   (b) needsCatchUp (ack failure/timeout enqueues it), OR
    //   (c) a FULL pass (startup step 9 / reconnect full-pass / S6c audit /
    //       waitConverged) whose computeCatchUpSet FULL branch keeps listDirty().
    // Adding listDirty() here would make every scoped pass O(n) during a first sync
    // (all n docs are dirty), defeating the O(n^2) → O(n) fix. Offline-edit re-push
    // on reconnect is covered by the onStatus reconnect full-pass added to start().
    // Open (active-bound) docIds: always in scope.
    for (const docId of this.openDocIds()) {
      workset.add(docId);
    }

    return { workset, liveByDocId, allByDocId };
  }

  /**
   * FULL convergence pass — the existing chain, ALWAYS unscoped.
   *
   * Runs: `runCatchUp(openDocIds()) → structuralReconcile() → settleCleanDocs()`
   * iterating EVERYTHING (no scoping). Used by:
   *   - `start()` step 9 — initial catch-up on adopt
   *   - `waitConverged()` — bounded convergence loop
   *   - (future) periodic audit pass
   *
   * Calls `structuralReconcile()` with NO scope so `materializeLiveDiskContent` runs
   * the FULL path (S4c does not scope this code path — only the observe path is scoped).
   * NEVER called from the hot observe loop (`runReconcileLoop`) — that uses
   * `runObserveScopedReconcile`.
   */
  async runFullConvergencePass(): Promise<void> {
    // S6a: set inFullConvergencePass to suppress spurious scheduleReconcile() calls from the
    // onBackstopWork seam while this full-chain pass is in progress. A full pass already processes
    // ALL backstop sets (via computeCatchUpSet's full-path loop + settleCleanDocs), so scheduling
    // a parallel observe-loop is harmful rather than helpful.
    this.inFullConvergencePass = true;
    try {
      await this.lazyAttach.runCatchUp(this.openDocIds());
      await this.structuralReconcile();
      // Clean-settle (0b-3 Fix 6): re-advance the synced stamp of any doc that has fully
      // converged (doc==disk==index) but whose synced stamp is latched at an intermediate
      // merge hash. Runs AFTER structural reconcile so disk is materialized.
      await this.lazyAttach.settleCleanDocs();
    } finally {
      this.inFullConvergencePass = false;
    }
  }

  /**
   * Stage 4b/4c/S5: OBSERVE-SCOPED reconcile entry point — the HOT PATH.
   *
   * Called from `runReconcileLoop` with the workset + maps bundle computed from the
   * changed batch and the backstop sets.
   *
   * S4b: `runCatchUp` is scoped to only the workset docIds (kills the O(n)
   * getSyncedStamp-per-entry scan on the hot path).
   *
   * S4c: `materializeLiveDiskContent` is scoped to the workset via `structuralReconcile(scope)`
   * (kills the O(n) vault.read scan — the dominant first-sync read cost).
   *
   * S5: `runStructuralReconcile`'s tombstone loops (rename, resurrect, delete) and the
   * divergent-rename loop are scoped to the workset via `scope.allByDocId` (the docId
   * closure expands each workset docId to its live + tombstoned sibling paths, so a
   * rename's old-key tombstone is reachable from the changed new key).
   *
   * S6b: `settleCleanDocs` is scoped to the workset (kills the O(n) getSyncedStamp +
   * getAttached + sha256OfText + diskHashOf scan on the hot path). `runFullConvergencePass`
   * still calls `settleCleanDocs()` with NO scope — the full path is unchanged.
   *
   * CONVERGENCE: byte-identical because the workset is a SUPERSET of every docId the full
   * scans would select (workset ⊇ {open ∪ dirty ∪ needsCatchUp ∪ changed-paths ∪ divergence
   * ∪ remoteUpdated}). Only the iteration order and the set of entries visited change —
   * not which docIds are selected or what is done to them.
   *
   * @param bundle - Result of `buildWorksetWithMaps`: workset + liveByDocId + allByDocId.
   */
  async runObserveScopedReconcile(bundle: {
    workset: Set<DocId>;
    liveByDocId: Map<DocId, VaultPath[]>;
    allByDocId: Map<DocId, VaultPath[]>;
  }): Promise<void> {
    // S4b: scope computeCatchUpSet to the workset.
    await this.lazyAttach.runCatchUp(this.openDocIds(), {
      workset: bundle.workset,
      liveByDocId: bundle.liveByDocId,
    });
    // S4c: scope materializeLiveDiskContent to the workset via structuralReconcile(scope).
    // S5: scope runStructuralReconcile's tombstone/divergent loops to the workset via
    // scope.allByDocId (the docId closure expansion to live + tombstoned sibling paths).
    // S6b: scope settleCleanDocs to the workset so the hot path is O(workset), not O(n).
    await this.structuralReconcile({
      workset: bundle.workset,
      liveByDocId: bundle.liveByDocId,
      allByDocId: bundle.allByDocId,
    });
    await this.lazyAttach.settleCleanDocs({
      workset: bundle.workset,
      liveByDocId: bundle.liveByDocId,
    });
  }

  private authorityFor(path: VaultPath): FileAuthority {
    let a = this.authorities.get(path);
    if (a === undefined) {
      a = new FileAuthority(path);
      this.authorities.set(path, a);
    }
    return a;
  }

  /**
   * True iff an editor is currently bound to `path`. NON-creating, unlike {@link authorityFor}: a path
   * with no authority yet CANNOT be `active-bound` (binding goes through `authorityFor`), so this peeks the
   * map instead of materializing an inactive authority. The disk-materialize gates call this in the hot
   * reconcile/catch-up loops — creating an authority there would be a pointless side effect AND would
   * perturb the operation-ordering of timing-sensitive non-editor conflict resolution.
   */
  private isActiveBound(path: VaultPath): boolean {
    return this.authorities.get(path)?.state === "active-bound";
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
    // M2: record the durable lastLivePath at the ingest bind. firePending is SYNC (called from
    // flushBumps + the debounce timers), so track the durable write instead of awaiting it — whenIdle
    // drains the inflight set. The index.observe → reconcile pass also re-records this path (idempotent).
    this.track(this.noteLiveBinding(pending.docId, path));
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

  // M1b quarantine thresholds. A WRONG hold is a no-op (the file stays); a wrong auto-propagate is
  // an unrecoverable false delete (spec section 3.6) — so these err toward holding.
  private static readonly MASS_DELETE_MIN = 10; // only apply the fraction test above this denominator
  private static readonly MASS_DELETE_FRACTION = 0.5;
  private static readonly SUBTREE_DROP_MIN = 3; // >=N missing siblings under one parent => a folder op

  /** A delete batch the engine should NOT auto-propagate even on a durable adapter. */
  private isSuspiciousDeleteBatch(paths: VaultPath[], confirmedLiveProseCount: number): boolean {
    if (paths.length === 0) return false;
    if (
      confirmedLiveProseCount >= SyncEngine.MASS_DELETE_MIN &&
      paths.length > SyncEngine.MASS_DELETE_FRACTION * confirmedLiveProseCount
    ) {
      return true; // mass wipe
    }
    // Subtree drop: count candidates under EACH ancestor directory (not only the immediate parent), so a
    // recursive folder delete scattered across sub-subfolders is still caught.
    const byAncestor = new Map<string, number>();
    for (const path of paths) {
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i++) {
        const ancestor = segments.slice(0, i).join("/");
        byAncestor.set(ancestor, (byAncestor.get(ancestor) ?? 0) + 1);
      }
    }
    for (const count of byAncestor.values()) if (count >= SyncEngine.SUBTREE_DROP_MIN) return true;
    return false;
  }

  /** M2: record that `docId` is now LIVE at `path` (durable, for displacement detection), and clear any
   *  stale delete-observation (a re-bind means it is not deleted). The bootstrap backstop (start of
   *  reconcileOfflineStructural) re-derives this from the converged index, so a missed runtime update
   *  self-heals on the next start. */
  private async noteLiveBinding(docId: DocId, path: VaultPath): Promise<void> {
    await this.ports.engineState.setLastLivePath(docId, path);
    await this.ports.engineState.clearDeleted(docId);
  }

  /**
   * OFFLINE STRUCTURAL RECONCILE — M1a. A startup disk-vs-index pre-pass for changes made while the engine
   * was NOT running (no watcher events). RE-KEYS offline renames INLINE (docId continuity) and RETURNS the
   * remaining vanished-synced-file set (`deferred`) + a content-hash index (`lostByHash`) for the
   * post-seed-loop handler {@link applyDeferredLost} to materialize / delete-route — deferred so a later
   * task can let the seed loop consume an in-place collision FIRST. It NEVER tombstones and NEVER deletes
   * base/docStore here: "synced entry + file absent" is ambiguous between a user delete and a torn/
   * never-written doc, so safely propagating a closed-app delete needs a durable signal (handled later).
   * Runs BEFORE the seed loop so a re-keyed `to` path is seen as already-bound and converges.
   */
  private async reconcileOfflineStructural(): Promise<{
    deferred: DeferredLost[];
    lostByHash: Map<string, DeferredLost | typeof AMBIGUOUS>;
    livePresentHashes: Set<string>;
    confirmedLiveProseCount: number;
  }> {
    // M2: backstop the durable lastLivePath from the converged index, so displacement detection has a
    // baseline even for bindings created before this device upgraded or missed by a runtime update. A
    // DISPLACED loser is NOT live here (it keeps its pre-collision lastLivePath from a prior session).
    // Use noteLiveBinding (setLastLivePath + clearDeleted) so a LIVE doc carrying a stale deleteObserved
    // (e.g. deleted then resurrected/recreated where the re-bind seam missed it) has the flag cleared —
    // otherwise a future collision of that doc would be wrongly skipped by the displacement detector and
    // the loser would be lost. A live entry is by definition not deleted, so clearing it is correct.
    // Both writes are skip-if-unchanged, so a converged steady-state restart still does ~zero durable writes.
    for (const [path, entry] of this.index.liveEntries()) {
      await this.noteLiveBinding(entry.docId, path);
    }

    const diskList = await this.ports.vault.list();
    const diskPaths = new Set<string>(diskList.map((e) => e.path));

    const lost: { path: VaultPath; docId: DocId; hash: string }[] = [];
    // The LOCAL base text per lost docId, kept aside so the materialize step writes the latest local
    // content (not a stale docStore snapshot). Engine-side so the pure matchRenames core stays content-free.
    // Keyed by docId: live index paths are one-docId-each; a same-docId-at-two-live-paths collision is an
    // M2 path-collision concern (guarded against in the rename loop below), not reachable here.
    const baseTextByDocId = new Map<DocId, string>();
    const materializedByDocId = new Map<DocId, Sha256>();
    const livePresentHashes = new Set<string>();
    const liveSet = new Set<string>();
    let liveProseCount = 0;
    for (const [path, entry] of this.index.liveEntries()) {
      liveSet.add(path);
      if (entry.type !== "crdt-prose") continue;
      liveProseCount++;
      if (diskPaths.has(path)) {
        // The live-elsewhere guard uses the index stamp (free, no I/O) rather than base.fileHash:
        // it is an exact match in steady state and only a CONSERVATIVE miss after an offline edit to
        // a still-live file (a missed guard at worst allows a re-key that just moves a docId — no loss).
        livePresentHashes.add(stampHash(entry.stamp));
        continue;
      }
      const base = await this.base.load(entry.docId);
      if (base === null) continue; // never materialized (fresh adopt) → catch-up materializes it normally
      // hash from the LOCAL base (base.fileHash == sha256OfText(base.baseText), an engine invariant); keep
      // the base text aside (keyed by docId) for the materialize step — see the materialize loop below.
      lost.push({ path, docId: entry.docId, hash: base.fileHash });
      baseTextByDocId.set(entry.docId, base.baseText);
      if (base.materializedHash !== undefined)
        materializedByDocId.set(entry.docId, base.materializedHash);
    }
    if (lost.length === 0)
      return {
        deferred: [],
        lostByHash: new Map(),
        livePresentHashes,
        confirmedLiveProseCount: liveProseCount, // no lost ⇒ all live prose is present/confirmed
      };

    const emptyHash = await sha256OfText("");
    const created: { path: VaultPath; hash: string }[] = [];
    for (const { path } of diskList) {
      if (liveSet.has(path)) continue;
      const bytes = await this.ports.vault.read(path);
      if (bytes === null) continue;
      if (classify(path, bytes, this.caps).route !== "crdt-prose") continue;
      created.push({ path, hash: await sha256OfText(canonicalizeProse(decode(bytes))) });
    }

    const { matches, unmatchedLost } = matchRenames(lost, created, {
      isExcludedPath: isTempPath,
      isTrivialHash: (h) => h === emptyHash,
      isLiveElsewhere: (h) => livePresentHashes.has(h),
    });

    // RENAME (M1a): re-key the docId to the new path. COLLISION GUARD: never re-key into a path holding a
    // DIFFERENT live docId (the M2 path-collision case) — skip it; a tombstoned target IS fine.
    for (const m of matches) {
      const target = this.index.get(m.to);
      if (target !== undefined && target.deleted !== true && target.docId !== m.docId) continue;
      applyRename(this.index, m.from, m.to);
      await this.noteLiveBinding(m.docId, m.to);
    }

    // UNMATCHED LOST (M1a/M1b): a vanished synced file that is NOT a rename. RATHER than materialize /
    // delete-route INLINE here, DEFER the whole set past the bootstrap seed loop (applyDeferredLost) so a
    // later task can let the seed loop consume an in-place collision (a created file that resolved this
    // exact docId's content) FIRST. Behaviour-equivalent for now: the seed loop consumes nothing yet, so
    // the deferred set is the full unmatched-lost set and applyDeferredLost replays the identical decision.
    // Record EVERYTHING the deferred handler needs (LOCAL base text + materializedHash) so it never
    // re-reads base; also index by content hash so a later task can detect an in-place collision.
    const deferred: DeferredLost[] = [];
    const lostByHash = new Map<string, DeferredLost | typeof AMBIGUOUS>();
    for (const l of unmatchedLost) {
      const d: DeferredLost = {
        path: l.path,
        docId: l.docId,
        hash: l.hash,
        baseText: baseTextByDocId.get(l.docId) ?? "",
        materializedHash: materializedByDocId.get(l.docId),
      };
      deferred.push(d);
      lostByHash.set(l.hash, lostByHash.has(l.hash) ? AMBIGUOUS : d);
    }
    // Mass-wipe denominator: count only the CONFIRMED population (present-on-disk + vanished-but-
    // materialized), NOT never-materialized-vanished docs (a fresh adopt never written to this disk was
    // never "here", so it must not dilute the suspicious-delete fraction). `lost` is the vanished prose;
    // those WITHOUT a materializedHash are the never-confirmed ones to exclude. A smaller denominator only
    // makes a mass wipe MORE likely to be caught — consistent with the err-toward-holding bias.
    const confirmedLiveProseCount = liveProseCount - (lost.length - materializedByDocId.size);
    return { deferred, lostByHash, livePresentHashes, confirmedLiveProseCount };
  }

  /**
   * POST-SEED-LOOP unmatched-lost handler (M1a/M1b). Replays the EXACT decision the former inline
   * reconcileOfflineStructural loop made — read-recheck absence, the SAME M1b clean-delete gate, materialize
   * (M1a) or delete-route (auto-propagate on a durable adapter vs hold-for-confirm) — but RUN AFTER the
   * bootstrap seed loop so a later task can let the seed loop consume an in-place collision first.
   *
   * LOAD-BEARING (the #1 M1b non-regression): the former inline materialize ran BEFORE the seed loop, so
   * the seed loop OBSERVED the materialized file and recorded `materializedHash` (its ~markMaterialized
   * step). That recorded signal is what lets the NEXT closed-app delete AUTO-PROPAGATE. Deferred past the
   * seed loop, that observe never happens — so this handler MUST mirror it: after a materialize, re-check
   * the live entry and call base.markMaterialized itself, else M1b closed-app deletes silently stop
   * propagating.
   */
  private async applyDeferredLost(
    deferred: DeferredLost[],
    confirmedLiveProseCount: number,
  ): Promise<void> {
    const deleteCandidates: {
      path: VaultPath;
      docId: DocId;
      hash: string;
      materializedHash: Sha256;
    }[] = [];
    let listingUnreliable = false;
    for (const l of deferred) {
      // READ-RECHECK (M1b): list() said absent — confirm with a DISK read AT HANDLING TIME (a file may
      // have appeared during the seed loop). read() hits disk via the adapter fallback, so a non-null
      // result means the LISTING was incomplete, NOT a delete.
      if ((await this.ports.vault.read(l.path)) !== null) {
        listingUnreliable = true; // an incomplete listing → hold any real candidates this batch
        continue; // present on disk: the bootstrap seed/adopt loop handled it; do NOT materialize over it
      }
      const entry = this.index.get(l.path);
      const mh = l.materializedHash;
      // A genuine delete candidate requires the confirmed-on-disk hash to match the index stamp AND the
      // working base (l.hash === materializedHash) AND the doc to be clean. If the working base is AHEAD
      // (an offline, debounced/unpushed edit — the index stamp can still be the old hash) or the doc is
      // dirty, this is NOT a clean delete: tombstoning would destroy the only copy of the unpushed edit.
      // Fall through to materialize (M1a), which writes base.baseText back and preserves it.
      if (
        mh !== undefined &&
        entry !== undefined &&
        entry.deleted !== true &&
        stampHash(entry.stamp) === mh &&
        l.hash === mh &&
        !(await this.ports.engineState.isDirty(l.docId))
      ) {
        deleteCandidates.push({ path: l.path, docId: l.docId, hash: l.hash, materializedHash: mh });
        continue; // a confirmed delete candidate — do NOT materialize here
      }
      // STALE / UNCONFIRMED (no materializedHash, or it != the current stamp) → MATERIALIZE (M1a) from the
      // LOCAL base text (echo-guarded). NOT a delete. We materialize from base.baseText, NOT a docStore
      // snapshot: an unattached DIRTY doc keeps its unpushed edit in baseText but its snapshot is
      // stale/absent (review B2). l.hash == sha256OfText(baseText), so the echo guard is exact.
      this.echo.recordWrite(l.path, l.hash);
      await this.ports.vault.writeAtomic(l.path, utf8(l.baseText));
      // MIRROR the seed-loop markMaterialized observe (load-bearing — else M1b closed-app deletes stop
      // auto-propagating). The seed loop no longer sees this materialize (it ran before us), so record
      // the OBSERVED-present signal here, gated the SAME way (present file's hash == the bound index stamp).
      const live = this.index.get(l.path);
      if (live !== undefined && live.deleted !== true && stampHash(live.stamp) === l.hash) {
        // l.hash IS a Sha256 at the source (DeferredLost.hash carries base.fileHash, a Sha256), but the
        // interface keeps it as `string` to stay content-format-agnostic — narrow it back here.
        await this.base.markMaterialized(live.docId, l.hash as Sha256);
      }
    }

    if (deleteCandidates.length > 0) {
      const durable = this.ports.vault.durabilityTrusted?.() === true;
      const suspicious =
        listingUnreliable ||
        this.isSuspiciousDeleteBatch(
          deleteCandidates.map((c) => c.path),
          confirmedLiveProseCount,
        );
      const autoPropagate = durable && !suspicious;
      for (const c of deleteCandidates) {
        if (autoPropagate) {
          // Genuine delete on a trusted adapter: tombstone with the CONFIRMED-on-disk hash (never
          // base.fileHash — the working base can be ahead of disk) + propagate. The file is already
          // absent, so nothing to remove.
          await this.tombstoneAndCleanup(c.path, c.docId, "crdt-prose", c.materializedHash);
        } else {
          // HOLD (non-durable adapter or a suspicious batch): materialize back (M1a — fail-safe, the
          // file reappears, no wedge, no data loss) and surface ONE pending-delete entry per path.
          // Confirmation, not recoverability, is the safety net (spec section 3.6).
          this.echo.recordWrite(c.path, c.hash);
          const rec = await this.base.load(c.docId);
          if (rec !== null) await this.ports.vault.writeAtomic(c.path, utf8(rec.baseText));
          this.inbox.add({
            id: `pending-delete:${c.path}:${c.materializedHash.slice(0, 8)}`,
            kind: "pending-delete",
            path: c.path,
            docId: c.docId,
            detail: `${c.path} appears to have been deleted while the app was closed. Confirm to remove it on all devices, or keep it.`,
          });
        }
      }
    }
  }

  /**
   * Recover an in-place collision (external `mv incoming → P`, closed-app) detected by the bootstrap seed
   * loop: P is present + bound LIVE but its disk content == a deferred-LOST doc's content (the incoming).
   * RE-KEY the incoming's content to a DEVICE-INDEPENDENT conflict artifact (reuse its docId — NOT
   * tombstoneAndCleanup, which would propagate a delete and lose the doc) and RESTORE the occupant from its
   * base. Both survive; the artifact path is deterministic (createdBy/createdTs from the incoming's
   * replicated create-meta), so every device converges to the SAME artifact after sync.
   */
  private async recoverInPlaceCollision(
    incoming: DeferredLost,
    occupantPath: VaultPath,
    occupantDocId: DocId,
    occupantBaseText: string,
    occupantBaseHash: Sha256,
  ): Promise<void> {
    const meta = await this.loadCreateMeta(incoming.docId);
    // Fallbacks are CONTENT-derived (device-independent) so two devices converge to the SAME artifact even
    // when the incoming's create-meta is unreadable (e.g. a zero-attach-adopted doc with no docStore snapshot).
    const ts = meta?.createdTs ?? incoming.hash.slice(0, 8);
    const by = meta?.createdBy ?? (`mv-${incoming.hash.slice(8, 16)}` as DeviceId);
    const artifactPath = conflictArtifactPath(occupantPath, by, ts);
    // Park the incoming's content at the artifact, RE-KEYED (reuse docId; NOT tombstoneAndCleanup).
    // (recordWrite takes a plain string; setStamp needs a Sha256 — incoming.hash is base.fileHash, a Sha256.)
    this.echo.recordWrite(artifactPath, incoming.hash);
    await this.ports.vault.writeAtomic(artifactPath, utf8(incoming.baseText));
    this.index.setStamp(artifactPath, incoming.docId, "crdt-prose", incoming.hash as Sha256);
    this.index.delete(incoming.path); // tombstone the incoming's old key (logical re-key)
    await this.noteLiveBinding(incoming.docId, artifactPath);
    await this.ports.engineState.markDirty(incoming.docId);
    this.inbox.add({
      id: `conflict:${artifactPath}:${incoming.docId}`,
      kind: "conflict",
      path: artifactPath,
      docId: incoming.docId,
      detail: `An external move landed on ${occupantPath}; the incoming note was kept as ${artifactPath}.`,
    });
    // Restore the occupant's content at P (echo-guarded) so the seed loop sees it converged.
    this.echo.recordWrite(occupantPath, occupantBaseHash);
    await this.ports.vault.writeAtomic(occupantPath, utf8(occupantBaseText));
    await this.base.markMaterialized(occupantDocId, occupantBaseHash);
  }

  /**
   * Load a doc's replicated `create` {@link OrphanMeta} (createdBy/createdTs) from the docStore snapshot,
   * matching {@link runOrphanSweep}'s `orphanData` access (crdt.loadDoc → meta map). Used to derive a
   * DEVICE-INDEPENDENT artifact path for an in-place collision recovery. Returns undefined if no snapshot
   * or no create-meta (a doc seeded before create-meta existed) — the caller falls back to the content hash.
   */
  private async loadCreateMeta(docId: DocId): Promise<OrphanMeta | undefined> {
    const snap = await this.ports.docStore.load(docId);
    if (snap === null) return undefined;
    const d = this.ports.crdt.loadDoc(docId, snap);
    const meta = d.getMap<OrphanMeta>("meta").get("create");
    d.destroy();
    return meta;
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
    // M1a: offline rename re-key happens INLINE; the unmatched-lost set is DEFERRED past the seed loop
    // (applyDeferredLost). The seed loop now CONSUMES an in-place collision first (an external mv onto an
    // occupied live path): `lostByHash`/`livePresentHashes` are the detection inputs for that.
    const { deferred, lostByHash, livePresentHashes, confirmedLiveProseCount } =
      await this.reconcileOfflineStructural();
    const emptyHash = await sha256OfText("");
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
        // ROBUSTNESS: a transient blob-store outage (S3/MinIO down -> 500) must NOT abort engine
        // start -- the prose engine must come up regardless. Swallow + continue; the blob stays
        // unpublished THIS session and re-publishes on the next start (bootstrap re-runs
        // onLocalBlobWrite for every on-disk blob, and blobStore.has() returns false while the
        // store was down, so a later successful start re-puts it). Prose sync is unaffected --
        // blob publish touches only the blob store + manifest, never the vault/prose path.
        try {
          await this.blobEngine.onLocalBlobWrite(path, bytes);
        } catch {
          // transient blob-store failure -- self-heals on the next start (see above).
        }
        continue;
      }
      if (route !== "crdt-prose") continue;

      // CANONICAL-LF (#35 + hash-identity): canonicalize the decoded PROSE to LF at this
      // decode boundary — we are past the `route !== "crdt-prose"` guard, so this only
      // touches prose. The seed/adopt/import decisions below all hash/seed THIS text into
      // the CRDT/base/index stamp, so LF must be canonical from here. See canonicalizeProse.
      const text = canonicalizeProse(decode(bytes));
      const diskHash = await sha256OfText(text);

      // IN-PLACE COLLISION (external mv onto an occupied live path, closed-app): this present path is bound
      // LIVE but its disk content diverged from its stamp, AND that disk content is exactly a deferred-LOST
      // doc's content → an `mv incoming → P` overwrote the occupant. Recover instead of ingesting the bytes
      // as an occupant edit. Guards: not trivial; UNIQUE (not AMBIGUOUS); NOT live elsewhere; occupant base present.
      if (
        existing !== undefined &&
        existing.deleted !== true &&
        stampHash(existing.stamp) !== diskHash
      ) {
        const incoming = lostByHash.get(diskHash);
        if (
          incoming !== undefined &&
          incoming !== AMBIGUOUS &&
          diskHash !== emptyHash &&
          !livePresentHashes.has(diskHash)
        ) {
          const occBase = await this.base.load(existing.docId);
          if (occBase !== null) {
            await this.recoverInPlaceCollision(
              incoming,
              path,
              existing.docId,
              occBase.baseText,
              occBase.fileHash,
            );
            const i = deferred.indexOf(incoming);
            if (i >= 0) deferred.splice(i, 1); // consume — applyDeferredLost must not also handle it
            lostByHash.set(diskHash, AMBIGUOUS); // consumed — a second occupied path must NOT re-key it
            continue; // P is restored on disk (occupant content == stamp); skip normal processing.
          }
        }
      }

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
          this.index.setStamp(path, docId, "crdt-prose", diskHash);
          await this.noteLiveBinding(docId, path);
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
          // CANONICAL-LF HOLE (review of 00f3819). When a zero-attach decision (adopt-server or
          // converge with needsAttach:false) keeps a PRE-EXISTING non-canonical (CRLF/lone-CR)
          // file on disk whose CANONICAL (LF) content already equals the synced/tree stamp, NO
          // later path rewrites it: the doc is never attached, so materializeLiveDiskContent and
          // settleCleanDocs skip it, and catch-up never selects it (synced == tree, not dirty,
          // not open) — yet pendingDocs' disk-hash clause hashes the RAW CRLF bytes against the
          // LF stamp → pending FOREVER → waitConverged throws. Close it the SAME way every other
          // canonical-LF site does: a ONE-TIME echo-guarded LF rewrite, raw-vs-canonical diffed.
          // This stays ZERO-ATTACH (M2): we only write the vault bytes, we do NOT attach the doc,
          // mint a docId, or touch index/inbox/blobs. needsAttach:true is left ALONE — that doc
          // attaches via catch-up and rewrites through the normal materialize path. CANNOT LOOP:
          // the rewrite's own fs event is echo-suppressed (recordWrite immediately precedes
          // writeAtomic), and a re-run finds raw == LF == canonical so the diff guard skips it.
          if (!result.needsAttach && text !== decode(bytes)) {
            const canonicalHash = await sha256OfText(text);
            // echo.recordWrite IMMEDIATELY precedes vault.writeAtomic, ALWAYS.
            this.echo.recordWrite(path, canonicalHash);
            await this.ports.vault.writeAtomic(path, utf8(text));
          }
          break;
      }

      // M1b: record that this docId's CURRENT content was OBSERVED present on disk this boot — but
      // only when the present file's hash equals the bound index stamp (so a delete next boot can be
      // told apart from a never-confirmed/torn doc). Idempotent: a no-op on an unchanged re-open.
      const live = this.index.get(path);
      if (live !== undefined && live.deleted !== true && stampHash(live.stamp) === diskHash) {
        await this.base.markMaterialized(live.docId, diskHash);
      }

      // M2: this docId is bound LIVE on disk this boot (its present file matches the persisted base),
      // so clear any stale deleteObserved it carries (e.g. deleted then recreated/resurrected where the
      // re-bind seam missed it). The reconcileOfflineStructural backstop clears it from a CONVERGED index
      // (the relay-synced restart populates liveEntries before bootstrap) — but a from-disk OFFLINE restart
      // takes the zero-attach "converge" decision and never re-lists the entry in the in-memory index, so
      // the flag must also be cleared HERE, keyed off the bootstrap docId + base, not the index entry.
      // Else a future collision of this doc would be wrongly skipped by the displacement detector and the
      // loser lost. Gated on a present file whose hash matches the base (a genuinely-live doc) so a
      // truly-deleted doc keeps its observation; skip-if-unchanged keeps a steady-state restart ~zero-write.
      const rec = await this.base.load(docId);
      if (rec !== null && rec.fileHash === diskHash) {
        await this.ports.engineState.clearDeleted(docId);
      }
    }

    // DEFERRED UNMATCHED-LOST (M1a/M1b): now that the seed loop has run (and a later task can let it
    // consume an in-place collision first), replay the materialize / delete-route decision for any
    // vanished synced file that was NOT a rename and NOT consumed by the seed loop.
    await this.applyDeferredLost(deferred, confirmedLiveProseCount);

    // Orphan sweep: recover any docId in the doc-set not bound by a live tree entry.
    // (Also re-run from the structural pass so a collision that surfaces AFTER sync
    // recovers — see {@link runOrphanSweep}.)
    await this.runOrphanSweep();

    // FIRST-SEEN DIRTY-ORPHAN PRUNE: a SIGKILL in the bumpStamp debounce window can leave a freshly-minted
    // docId marked dirty BEFORE its index entry (and snapshot) became durable. After the orphan sweep — which
    // recovers any dirty docId that DOES have a snapshot (binding it live) — a dirty docId with NO live
    // binding AND NO docStore snapshot is unreachable cruft: catch-up can't reach it (no live entry) and
    // there is nothing to push (no snapshot). Left alone it counts toward pendingDocs and WEDGES
    // waitConverged forever. Clear it; the file re-seeds under a fresh docId, so no content is lost. (A
    // legitimate unpushed edit always has a live entry OR a snapshot, so it is never pruned.)
    const liveDocIds = new Set<DocId>(this.index.liveEntries().map(([, e]) => e.docId));
    const snapshotDocIds = new Set<DocId>(await this.ports.docStore.list());
    for (const dirty of await this.ports.engineState.listDirty()) {
      if (!liveDocIds.has(dirty) && !snapshotDocIds.has(dirty)) {
        await this.ports.engineState.clearDirty(dirty);
      }
    }
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
    const { recovered } = await orphanSweep(
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

          // M2 precise displacement detection: skip a genuinely-deleted doc; recover an orphan whose
          // LAST-LIVE path is now bound to a DIFFERENT live docId (a path collision displaced it). For a
          // create-loser lastLivePath == meta.originalPath (behavior preserved); a rename-loser (whose
          // create path is tombstoned) is now recovered too. Recovery path stays meta.originalPath-based
          // (device-independent => deterministic).
          if (await this.ports.engineState.wasDeleted(docId)) return null;
          const lastPath = await this.ports.engineState.getLastLivePath(docId);
          if (lastPath === null) return null;
          const occupant = this.index.get(lastPath);
          if (occupant === undefined || occupant.deleted === true || occupant.docId === docId)
            return null;

          return { text, type: "crdt-prose" as Route, meta };
        },
      },
    );
    // M2: a recovered orphan is now bound LIVE at its conflict path — record the durable baseline.
    for (const rec of recovered) await this.noteLiveBinding(rec.docId, rec.path);
  }

  // ── vault events ───────────────────────────────────────────────────────────

  /**
   * M3 live-rename coalescer dispatch. The watcher has no native external-rename event: an external
   * `mv old new` arrives as `delete(old)` + `modify/create(new)`. Rather than tombstone+propagate
   * `old` and ingest `new` as a fresh docId (losing continuity), we BUFFER the two rename SIGNALS for
   * a debounced window and resolve them through the same pure `matchRenames` core as bootstrap
   * (re-key on a content match). Everything else dispatches immediately, exactly as before.
   *
   * - synthetic `rename` (engine-mediated `vault.rename`) → {@link onRename} as today (bypasses buffer).
   * - `delete` of a bound-live prose path → buffer as a rename SOURCE (capture docId + base.fileHash).
   * - `modify`/`create` to an UNBOUND path → buffer as a rename TARGET.
   * - `modify`/`create` to a bound-live path (a normal edit) → {@link onWrite} immediately.
   * - `delete` of a not-bound-live path → {@link onDelete} immediately (early-returns if tombstoned).
   *
   * Coalescing is OFF in projector mode (`ingestDisabled`): a read-only projector mutates no index.
   */
  private onVaultEvent(e: VaultEvent): void {
    if (e.type === "rename") {
      this.onRename(e.oldPath, e.path);
      return;
    }
    const coalesce = this.config.ingestDisabled !== true;
    if (e.type === "delete") {
      const entry = this.index.get(e.path);
      // DIR-DELETE EXPANSION (F4: no LIVE entry — undefined OR tombstoned — but live children under it):
      // an external `mv <dir>` arrives as delete(old-dir) + create(new-subtree) with NO per-child source
      // events. Synthesize a per-child delete for each live child and re-dispatch through THIS routing
      // (prose -> bufferRenameSource; quarantined -> suppressed; blob -> onDelete). Children have a live
      // entry so they never re-enter this branch (no recursion).
      if (coalesce && (entry === undefined || entry.deleted === true)) {
        const children = this.liveChildrenUnder(e.path); // snapshot array BEFORE re-dispatch
        if (children.length > 0) {
          for (const child of children) this.onVaultEvent({ type: "delete", path: child });
          return;
        }
      }
      const isRenameSource =
        coalesce &&
        entry !== undefined &&
        entry.deleted !== true &&
        entry.type === "crdt-prose" &&
        !this.renameTxn.suppressDelete(e.path);
      if (isRenameSource) this.track(this.bufferRenameSource(e.path, entry));
      else this.track(this.onDelete(e.path));
      return;
    }
    // create | modify
    const entry = this.index.get(e.path);
    const isRenameTarget = coalesce && (entry === undefined || entry.deleted === true);
    if (isRenameTarget) this.bufferRenameTarget(e.path);
    else this.track(this.onWrite(e.path)); // normal edit to a bound-live path
  }

  /** Test seam: drives the REAL vault-event handler (so a test simulates the watcher honestly). */
  onVaultEventForTest(e: VaultEvent): void {
    this.onVaultEvent(e);
  }

  /**
   * Live (non-tombstoned) child paths strictly under `dir/`. The live INDEX is the authoritative
   * known-paths oracle for dir-delete expansion: an external `mv <dir>` fires only `delete <dir>`
   * (no per-child source events), so we recover the moved-away sources from here.
   */
  private liveChildrenUnder(dir: VaultPath): VaultPath[] {
    const prefix = (dir.endsWith("/") ? dir.slice(0, -1) : dir) + "/"; // F7: trim trailing slash
    const out: VaultPath[] = [];
    for (const [path] of this.index.liveEntries()) {
      if (path.startsWith(prefix)) out.push(path); // `notes/` matches notes/a.md, never notes-backup/x.md
    }
    return out;
  }

  /**
   * Buffer a bound-live prose `delete` as a rename SOURCE. The file is GONE, so the source hash is the
   * doc's `base.fileHash` (mirrors bootstrap's lost-set construction). No base ⇒ not a rename source
   * (nothing to re-key) ⇒ fall through to the normal delete path.
   */
  private bufferRenameSource(path: VaultPath, entry: TreeEntry): Promise<void> {
    // The base.load (for the moved-content hash) is ASYNC and could be outrun by the debounce timer,
    // leaving a drain with a target but not its still-loading source — splitting a real rename into a
    // fresh-docId ingest + clean-delete (F1). Register the in-flight buffering in `pendingSources` so a
    // timer-driven `drainRenameBuffer` awaits it before snapshotting. (whenIdle already drains `inflight`
    // first; this closes the timer path.)
    this.renameBuf.pendingSourcePaths.add(path); // clause-1 ownership across the async base.load
    const pen = (async () => {
      const rec = await this.base.load(entry.docId);
      if (rec === null) {
        this.track(this.onDelete(path));
        return;
      }
      this.renameBuf.sources.set(path, { docId: entry.docId, hash: rec.fileHash });
      this.armRenameWindow();
    })();
    this.renameBuf.pendingSources.add(pen);
    void pen.finally(() => {
      this.renameBuf.pendingSources.delete(pen);
      this.renameBuf.pendingSourcePaths.delete(path);
    });
    return pen;
  }
  /** Buffer a write to an UNBOUND path as a rename TARGET (read + hashed at drain). */
  private bufferRenameTarget(path: VaultPath): void {
    this.renameBuf.targets.add(path);
    this.armRenameWindow();
  }
  /**
   * Arm (or re-arm) the debounce window. RE-ARMED on each newly-buffered signal, but HARD-CAPPED from
   * the first armed signal so a folder-move burst always drains as one batch (rather than splitting
   * delete/create pairs across drains). When the cap is reached, drain immediately.
   */
  private armRenameWindow(): void {
    const now = this.ports.clock.now();
    this.renameBuf.firstArmedAt ??= now;
    if (this.renameBuf.timer !== null) clearTimeout(this.renameBuf.timer);
    const delay = this.renameDrainDelay(now, this.renameBuf.firstArmedAt);
    this.renameBuf.timer = setTimeout(() => {
      this.track(this.runRenameDrain());
    }, delay);
  }
  /**
   * The debounce delay for the next drain, given `now` and when the window was first armed. The base
   * window is CLAMPED to the remaining cap budget (F4): a steady sub-window event cadence would otherwise
   * keep re-arming a full window and push the drain a whole window PAST `firstArmedAt + cap`. Clamping
   * makes the cap a HARD ceiling — the batch always drains BY the cap. Never negative.
   */
  private renameDrainDelay(now: number, firstArmedAt: number): number {
    const capRemaining = Math.max(0, this.renameWindowCapMs - (now - firstArmedAt));
    return Math.min(this.renameWindowMs, capRemaining);
  }
  /** Single-flight drain: a re-arm during an in-flight drain reuses the same promise. */
  private runRenameDrain(): Promise<void> {
    if (this.renameBuf.draining !== null) return this.renameBuf.draining;
    const drain = this.drainRenameBuffer().finally(() => {
      this.renameBuf.draining = null;
      this.renameBuf.drainingTargets = new Set(); // F2: release the target reservation when the drain ends
      this.renameBuf.drainingSources = new Set();

      // LIVENESS: a signal buffered WHILE this drain was in flight re-armed a debounce timer; if that
      // timer already fired (its callback saw `draining !== null` and returned this drain WITHOUT
      // re-processing) the buffer is left refilled with a DEAD timer. Re-arm so it drains — otherwise
      // the refill is stranded until the next vault event or a whenIdle/waitConverged force-drain.
      if (this.renameBuf.sources.size > 0 || this.renameBuf.targets.size > 0)
        this.armRenameWindow();
    });
    this.renameBuf.draining = drain;
    return drain;
  }
  /**
   * Drain the rename buffer: build `lost`/`created`, run the SAME pure `matchRenames` core as bootstrap,
   * re-key each content-matched pair (docId continuity, no delete propagated), and route the remainder.
   * (Task 1 keeps behaviour parity for the non-matched remainder; Tasks 2/3 refine it.)
   */
  private async drainRenameBuffer(): Promise<void> {
    // F1: await any in-flight source buffering (its async base.load) BEFORE snapshotting, so a
    // timer-driven drain never reads a half-populated buffer (a target without its still-loading source)
    // and splits the rename. Signals that arrive DURING this await belong to the next window — the
    // single-flight + finally re-arm in runRenameDrain picks them up.
    if (this.renameBuf.pendingSources.size > 0) {
      await Promise.allSettled([...this.renameBuf.pendingSources]);
    }
    if (this.renameBuf.timer !== null) {
      clearTimeout(this.renameBuf.timer);
      this.renameBuf.timer = null;
    }
    const sources = [...this.renameBuf.sources];
    const targets = [...this.renameBuf.targets];
    this.renameBuf.sources = new Map();
    this.renameBuf.targets = new Set();
    // F2: RESERVE the snapshotted targets (synchronously, before any await) so a concurrent
    // `requestRename` cannot vault.rename onto one mid-drain and clobber its still-unread bytes.
    // `runRenameDrain`'s finally releases the reservation when the drain ends.
    this.renameBuf.drainingTargets = new Set(targets);
    this.renameBuf.drainingSources = new Set(sources.map(([pth]) => pth));
    this.renameBuf.firstArmedAt = null;
    if (sources.length === 0 && targets.length === 0) return;

    const emptyHash = await sha256OfText("");
    const lost = sources.map(([path, s]) => ({ path, docId: s.docId, hash: s.hash }));
    const created: { path: VaultPath; hash: string }[] = [];
    for (const path of targets) {
      const bytes = await this.ports.vault.read(path);
      if (bytes === null) continue; // vanished during the window
      if (classify(path, bytes, this.caps).route !== "crdt-prose") {
        this.track(this.onWrite(path)); // non-prose target → normal ingest, never a re-key
        continue;
      }
      created.push({ path, hash: await sha256OfText(canonicalizeProse(decode(bytes))) });
    }
    // livePresentHashes: stamp-hashes of CURRENT live prose, EXCLUDING the buffered sources (in-memory,
    // no I/O — mirrors bootstrap engine.ts ~2533-2537). Guards a re-key that would steal a docId whose
    // content is still live elsewhere.
    // TODO(m3-followup): share the matchRenames wiring with reconcileOfflineStructural to prevent drift.
    const sourceSet = new Set(sources.map(([pth]) => pth));
    const livePresentHashes = new Set<string>();
    for (const [pth, ent] of this.index.liveEntries()) {
      if (ent.type !== "crdt-prose" || sourceSet.has(pth)) continue;
      livePresentHashes.add(stampHash(ent.stamp));
    }
    const { matches, unmatchedLost, unmatchedCreated } = matchRenames(lost, created, {
      isExcludedPath: isTempPath,
      isTrivialHash: (h) => h === emptyHash,
      isLiveElsewhere: (h) => livePresentHashes.has(h),
    });
    for (const m of matches) {
      // RE-VALIDATE `from` (§4.2): a REMOTE op during the window may have tombstoned or re-bound it.
      // `IndexDoc.rename` unconditionally sets the target `deleted:false`, so a naive `applyRename`
      // would RESURRECT a remotely-tombstoned docId. If `from` is no longer LIVE under the SAME docId,
      // abandon the match — the remote delete wins — and ingest the target as a fresh file (content
      // preserved). The target was held unbound, so onWrite gives it a new docId, not the dead one.
      const cur = this.index.get(m.from);
      if (cur === undefined || cur.deleted === true || cur.docId !== m.docId) {
        this.track(this.onWrite(m.to));
        continue;
      }
      // TARGET-OCCUPANCY GUARD (F3 — mirror the bootstrap matched-rename guard, engine.ts ~2662): a
      // REMOTE op during the window may have re-bound `m.to` to a DIFFERENT live docId. `IndexDoc.rename`
      // overwrites `to` unconditionally, so an un-guarded `applyRename` would CLOBBER that live binding.
      // Refuse the re-key; the source's file is gone, so route it as a genuine delete (no live-but-missing
      // wedge). (Full M2-style conflict recovery of the displaced source is the runtime path-collision
      // follow-on; this floor just refuses to destroy the occupant's binding.)
      const occupant = this.index.get(m.to);
      if (occupant !== undefined && occupant.deleted !== true && occupant.docId !== m.docId) {
        await this.gatedLiveDelete(m.from, m.docId);
        continue;
      }
      applyRename(this.index, m.from, m.to);
      await this.noteLiveBinding(m.docId, m.to);
    }
    // Unmatched lost = a genuine delete → GATED delete (clean propagate / dirty materialize-back).
    for (const l of unmatchedLost) await this.gatedLiveDelete(l.path, l.docId);
    // Unmatched created = a genuine new file → ingest now. `matchRenames` returns DISJOINT
    // matches/unmatchedCreated, so no `m.to` appears here (and an abandoned match's `m.to` is already
    // onWrite-ingested in the re-validate branch above) — ingest each directly.
    for (const c of unmatchedCreated) this.track(this.onWrite(c.path));
  }

  /**
   * Unmatched buffered source = a genuine delete. The watcher delivered an EXPLICIT `delete` event for
   * a file that WAS on disk, so — unlike the closed-app listing (ambiguous between a real delete and a
   * torn/incomplete listing, hence its `durable`/suspicious gate) — the runtime signal is unambiguous:
   * a CLEAN doc → tombstone + propagate (matching the pre-M3 `onDelete`, which had no durability gate).
   * The ONLY runtime hazard the gate guards is the edit-then-mv race (§4.3 / key insight): a DIRTY doc,
   * or one whose working base is AHEAD of its bound index stamp (an unpushed offline edit), must NOT be
   * tombstoned — that would destroy the only copy of the edit. Such a doc MATERIALIZES BACK from base
   * (M1a fail-safe: echo-guarded re-write of base.baseText at the path, preserving the unpushed edit and
   * avoiding a live-but-missing entry that would wedge runtime quiescence).
   *
   * CLEAN is `base.fileHash === stampHash(entry.stamp)` — the working base equals the BOUND index
   * content, so there is NO divergent edit to lose; the delete is unambiguous and propagates. We do NOT
   * also require `!isDirty`: `dirty` only means "not yet PUSHED" (e.g. an offline create/edit-then-
   * delete), not "has content diverging from the bound stamp" — and a delete must still win over an
   * unpushed-but-non-divergent change (the tombstone simply propagates the removal). Only a base AHEAD
   * of the stamp (`base.fileHash !== stamp` — a real unpushed edit, incl. one a concurrent remote edit
   * advanced into base via catch-up; the edit-beats-delete key insight) blocks the tombstone. This does
   * NOT key off `materializedHash` (a synced RECEIVER never records it at runtime — only the bootstrap
   * observe does — so requiring it would wrongly hold every receiver's genuine delete). We re-load the
   * base here so a base advance DURING the window is reflected (the captured buffer-time hash is stale).
   */
  private async gatedLiveDelete(path: VaultPath, docId: DocId): Promise<void> {
    const entry = this.index.get(path);
    if (entry === undefined || entry.deleted === true) return; // already handled / re-bound
    const rec = await this.base.load(docId);
    if (rec === null) return; // no base to reason about — leave the live entry (next bootstrap resolves)
    const clean = rec.fileHash === stampHash(entry.stamp);
    if (clean) {
      // Genuine clean delete: tombstone with the bound content hash + propagate. The file is already
      // absent, so nothing to remove. (rec.fileHash === the bound index stamp here, by the clean gate.)
      await this.tombstoneAndCleanup(path, docId, entry.type, rec.fileHash);
      return;
    }
    // DIRTY / base-ahead (an unpushed edit) → MATERIALIZE-BACK (M1a, echo-guarded) from the LOCAL base
    // text. The edit survives at the old path and pushes from there; the file reappears (no wedge).
    this.echo.recordWrite(path, rec.fileHash);
    await this.ports.vault.writeAtomic(path, utf8(rec.baseText));
    // MIRROR the bootstrap markMaterialized observe, gated the SAME way (the present file's hash == the
    // bound index stamp) — keeps a later closed-app delete of this doc auto-propagating.
    const live = this.index.get(path);
    if (live !== undefined && live.deleted !== true && stampHash(live.stamp) === rec.fileHash) {
      await this.base.markMaterialized(live.docId, rec.fileHash);
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
        // (origin "local-bridge", which the transport RELAYS) → observe → the background fetch
        // queue enqueues → materialize → write → fs event → … an unbounded feedback loop that floods disk + the
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

  /**
   * Lay an edit-beats-delete tombstone for a BOUND docId + run the local cleanup (clear echo, clear
   * the stranded dirty flag, drop base + docStore snapshot). Shared by the live-delete path
   * ({@link onDelete}, which passes the working-base hash) and M1b's closed-app delete propagation
   * (which passes the confirmed-on-disk materializedHash). Bound-docId-only — never a concurrent-
   * create loser — so the orphan sweep's recovery snapshot is never removed here.
   *
   * The dirty flag is cleared because a deleted note has no live index path, so catch-up's
   * computeCatchUpSet can never map that dirty docId back to a path to clear it — left dirty it
   * would report pending forever and wedge waitConverged. Resurrection re-marks dirty via the
   * normal inbound ingest path, not this stale flag.
   */
  private async tombstoneAndCleanup(
    path: VaultPath,
    docId: DocId,
    type: Route,
    contentSha: Sha256,
  ): Promise<void> {
    recordTombstone(this.index, path, docId, type, this.ports.identity.deviceId(), contentSha);
    this.echo.clear(path);
    // M2: record the delete DURABLY before removing the snapshot, so a delete racing a path-reuse (or a
    // crash mid-cleanup) is never resurrected by the displacement detector.
    await this.ports.engineState.markDeleted(docId);
    await this.ports.engineState.clearDirty(docId);
    await this.base.delete(docId);
    await this.ports.docStore.delete(docId);
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
    await this.tombstoneAndCleanup(path, entry.docId, entry.type, sha);
  }
}
