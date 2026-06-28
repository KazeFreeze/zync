import type { ClockPort, Sha256, VaultPath } from "../ports.js";
import { BlobTransientError, BlobNotFoundError, CorruptBlobError } from "../errors.js";
import type { BlobManifestEntry } from "./blob-engine.js";

/** Outcome of one materialize attempt (the queue drives this callback). */
export type MaterializeOutcome = "written" | "already" | "superseded";

export interface BlobFetchQueueDeps {
  /** Fetch+verify+write the path's CURRENT manifest sha; re-validates the manifest before writing
   *  (generation-aware). `superseded` = the manifest moved during the fetch (queue re-enqueues). */
  materialize: (path: VaultPath, expectedSha: Sha256) => Promise<MaterializeOutcome>;
  /** Pure snapshot of all advertised manifest entries (for progress/settled totals). */
  manifestEntries: () => [VaultPath, BlobManifestEntry][];
  clock: ClockPort;
  /** Called with the CURRENT full failed-path set whenever it changes (aggregate inbox surfacing). */
  onFailure: (failedPaths: VaultPath[]) => void;
  concurrency: number;
  maxInFlightBytes: number;
  maxRetries: number;
  retryTickMs: number;
}

interface Job {
  path: VaultPath;
  targetSha: Sha256;
  size: number;
  attempts: number;
}

/**
 * Bounded-concurrency, byte-budgeted, typed-retry blob fetch queue (background best-effort). Replaces
 * the fire-and-forget eager sweep + the sequential drainEagerBlobs path. See the design spec s3.
 */
export class BlobFetchQueue {
  readonly #d: BlobFetchQueueDeps;
  readonly #queued = new Map<VaultPath, Job>();
  /** Maps in-flight path → the sha currently being fetched. */
  readonly #inFlight = new Map<VaultPath, Sha256>();
  readonly #failed = new Set<VaultPath>();
  readonly #retryTimers = new Map<VaultPath, ReturnType<typeof setTimeout>>();
  #inFlightBytes = 0;
  #materialized = 0;
  #stopped = false;
  #tick: ReturnType<typeof setInterval> | null = null;
  /**
   * Drain-mode resolvers. While non-empty, `#pump` stops dispatching new work so
   * in-flight jobs can complete. Resolvers fire when `#inFlight.size` reaches 0.
   * (A caller may enqueue more items after the drain; a subsequent `#pump` will
   * restart normal dispatch once `#drainWaiters` is empty.)
   */
  #drainWaiters: (() => void)[] = [];

  constructor(deps: BlobFetchQueueDeps) {
    this.#d = deps;
  }

  /** Start the low-frequency heal-retry tick (re-enqueues parked failures). Idempotent. */
  start(): void {
    this.#stopped = false;
    if (this.#tick !== null) return;
    this.#tick = setInterval(() => {
      if (this.#failed.size === 0) return;
      for (const path of [...this.#failed]) {
        const cur = this.#currentEntry(path);
        if (cur) this.enqueue(path, cur.sha256, cur.size); // path leaves #failed only on a successful re-materialize
      }
    }, this.#d.retryTickMs);
  }

  /** Cancel the tick + all retry timers + drop pending work (called on engine stop). */
  stop(): void {
    this.#stopped = true;
    if (this.#tick !== null) {
      clearInterval(this.#tick);
      this.#tick = null;
    }
    for (const t of this.#retryTimers.values()) clearTimeout(t);
    this.#retryTimers.clear();
    this.#queued.clear();
  }

  #currentEntry(path: VaultPath): BlobManifestEntry | undefined {
    for (const [k, v] of this.#d.manifestEntries()) if (k === path) return v;
    return undefined;
  }

  /** Enqueue (or re-target) a path. Newer sha re-targets even if queued; same-sha in-flight is a no-op. */
  enqueue(path: VaultPath, sha: Sha256, size: number): void {
    // A fresh enqueue supersedes any pending retry of an OLDER sha for this path: cancel the armed
    // timer so its (stale-sha) callback can never clobber the job we are about to (re-)target.
    const armed = this.#retryTimers.get(path);
    if (armed !== undefined) {
      clearTimeout(armed);
      this.#retryTimers.delete(path);
    }
    if (this.#inFlight.has(path)) {
      // Path is currently being fetched.
      if (this.#inFlight.get(path) === sha) {
        // Same sha already in-flight — complete no-op (also discard any stale pending re-target).
        const cur = this.#queued.get(path);
        if (cur?.targetSha === sha) this.#queued.delete(path);
        return;
      }
      // Different sha: queue a re-target to run after the current fetch finishes.
      const cur = this.#queued.get(path);
      if (cur?.targetSha !== sha)
        this.#queued.set(path, { path, targetSha: sha, size, attempts: 0 });
      return;
    }
    const existing = this.#queued.get(path);
    if (existing?.targetSha === sha) return;
    // NB: do NOT clear #failed here — it is cleared only on a successful re-materialize (see #run).
    // Clearing on enqueue would make the aggregate inbox item flap off/on every heal tick during a
    // sustained outage; clearing on success keeps #failed == "currently parked".
    this.#queued.set(path, { path, targetSha: sha, size, attempts: existing?.attempts ?? 0 });
    this.#pump();
  }

  #pump(): void {
    // In drain-mode (active waiters), do not start new work — let in-flight complete first.
    if (!this.#stopped && this.#drainWaiters.length === 0) {
      for (const job of this.#queued.values()) {
        // A re-target queued WHILE its path is still in-flight (enqueue's different-sha branch, live
        // from Task 4+) stays queued until the in-flight run finishes — never double-dispatched.
        if (this.#inFlight.has(job.path)) continue;
        if (this.#inFlight.size >= this.#d.concurrency) break;
        if (this.#inFlight.size > 0 && this.#inFlightBytes + job.size > this.#d.maxInFlightBytes)
          continue;
        this.#queued.delete(job.path);
        void this.#run(job);
      }
    }
    // Fire drain waiters once all in-flight work has settled.
    if (this.#inFlight.size === 0 && this.#drainWaiters.length > 0) {
      const w = this.#drainWaiters;
      this.#drainWaiters = [];
      for (const r of w) r();
      // Resume normal dispatch in case items remain queued after the drain.
      this.#pump();
    }
  }

  async #run(job: Job): Promise<void> {
    this.#inFlight.set(job.path, job.targetSha);
    this.#inFlightBytes += job.size;
    try {
      const outcome = await this.#d.materialize(job.path, job.targetSha);
      // `superseded` = the manifest moved during the fetch; the fresh sha arrives via a manifest-observe
      // enqueue (Task 6 wires the BlobEngine observe), so nothing to re-enqueue here. Only a real write
      // counts toward materialized progress.
      if (outcome !== "superseded") this.#materialized++;
      // A successful re-materialize heals a previously-parked failure; re-emit the aggregate report so
      // the inbox item resolves once the LAST parked path clears (fires onFailure([]) on full recovery).
      // Suppress the notify after stop() (in-flight heal during shutdown -> torn-down consumer); the
      // #failed.delete still runs (left operand) so the set stays accurate. Mirrors #onError's guard.
      if (this.#failed.delete(job.path) && !this.#stopped) this.#d.onFailure([...this.#failed]);
    } catch (err) {
      this.#onError(job, err);
    } finally {
      this.#inFlight.delete(job.path);
      this.#inFlightBytes -= job.size;
      this.#pump();
    }
  }

  #onError(job: Job, err: unknown): void {
    if (this.#stopped) return;
    const transient = err instanceof BlobTransientError || err instanceof BlobNotFoundError;
    const corruptRetryable = err instanceof CorruptBlobError && job.attempts < 1;
    if ((transient || corruptRetryable) && job.attempts < this.#d.maxRetries) {
      const backoff = Math.min(30_000, 250 * 2 ** job.attempts);
      const jitter = backoff * 0.2 * ((this.#d.clock.now() % 1000) / 1000 - 0.5) * 2; // deterministic-ish
      const delay = Math.max(50, backoff + jitter);
      const t = setTimeout(() => {
        this.#retryTimers.delete(job.path);
        // Defense-in-depth for the fired-but-not-yet-run race: never overwrite a newer queued job
        // (a re-enqueue with a fresher sha may have landed between the timer firing and this callback).
        if (!this.#queued.has(job.path)) {
          this.#queued.set(job.path, { ...job, attempts: job.attempts + 1 });
        }
        this.#pump();
      }, delay);
      this.#retryTimers.set(job.path, t);
      return;
    }
    // PARK: exhausted / permanent / corrupt-after-1 -> failed set + aggregate report.
    this.#failed.add(job.path);
    this.#d.onFailure([...this.#failed]);
  }

  progress(): { materialized: number; total: number; failed: number } {
    return {
      materialized: this.#materialized,
      total: this.#d.manifestEntries().length,
      failed: this.#failed.size,
    };
  }

  /** Resolves when no queued + no in-flight + no armed retry timers (everything materialized or failed). */
  whenSettled(): Promise<void> {
    if (this.#isSettled()) return Promise.resolve();
    return new Promise<void>((res) => {
      const poll = setInterval(() => {
        if (this.#isSettled()) {
          clearInterval(poll);
          res();
        }
      }, 5);
    });
  }

  #isSettled(): boolean {
    return this.#queued.size === 0 && this.#inFlight.size === 0 && this.#retryTimers.size === 0;
  }

  /** Synchronous settled snapshot: no queued + no in-flight + no armed retry timers. */
  settled(): boolean {
    return this.#isSettled();
  }

  /**
   * Resolves when all currently in-flight work has completed. Queued-but-not-yet-dispatched
   * items are held until the drain resolves, then dispatched in the next pump cycle.
   * (Callers that need to wait for every enqueued item should await `whenDrained()` only
   * after all enqueue calls have been made.)
   */
  whenDrained(): Promise<void> {
    if (this.#inFlight.size === 0) return Promise.resolve();
    return new Promise<void>((res) => this.#drainWaiters.push(res));
  }
}
