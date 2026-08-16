/**
 * EchoLedger — echo suppression for filesystem write-back events.
 *
 * When the bridge writes a file it records the intended content-hash here.
 * When the filesystem watcher fires, the engine calls `isEcho` to check
 * whether the event is a reflection of our own write (and should be ignored)
 * or a genuine external change (and should be ingested).
 *
 * ## Multi-entry design (NEW-7 fix)
 *
 * A single-slot ledger (path → one hash) breaks under pipelining: if the
 * engine records v2 and then v3 before v2's filesystem event arrives, the
 * v2 event would find the slot already overwritten by v3 and be treated as
 * external — seeding a ping-pong loop when a formatter is present.
 *
 * The fix is a path → Set<hash> map so every in-flight write is remembered
 * independently.  `isEcho` removes the matched entry on first match ("consume
 * once"), so a duplicate fs event for the same bytes is correctly treated as
 * external.
 *
 * ## Scope
 *
 * This handles content (`modify`/`create`) echoes where the final disk bytes
 * are available for hashing.  `delete`/`rename` echoes (no content hash) are
 * tracked at the engine-wiring level in Phase 0b-2.
 */
export class EchoLedger {
  readonly #pending = new Map<string, Map<string, number>>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxPerPath: number;
  readonly #maxTotal: number;
  #size = 0;

  constructor(options?: {
    now?: () => number;
    ttlMs?: number;
    maxPerPath?: number;
    maxTotal?: number;
  }) {
    this.#now = options?.now ?? Date.now;
    this.#ttlMs = options?.ttlMs ?? 2 * 60_000;
    this.#maxPerPath = options?.maxPerPath ?? 8;
    this.#maxTotal = options?.maxTotal ?? 4_096;
  }

  /**
   * Record that we are about to write `hash` to `path`.
   * May be called multiple times before the corresponding fs events arrive.
   */
  recordWrite(path: string, hash: string): void {
    const now = this.#now();
    this.#pruneExpired(now);
    let hashes = this.#pending.get(path);
    if (hashes === undefined) {
      hashes = new Map();
      this.#pending.set(path, hashes);
    }
    if (hashes.delete(hash)) {
      this.#size--;
    }
    hashes.set(hash, now);
    this.#size++;

    // A watcher that drops events must not let one hot path crowd out every other echo token.
    while (hashes.size > this.#maxPerPath) {
      const oldest = hashes.keys().next().value;
      if (oldest === undefined) break;
      hashes.delete(oldest);
      this.#size--;
    }
    this.#evictGlobalOverflow();
  }

  /**
   * Returns `true` and consumes the entry if `diskHash` matches one of our
   * recorded intended hashes for `path`; otherwise returns `false` leaving
   * any other pending entries intact.
   */
  isEcho(path: string, diskHash: string): boolean {
    this.#pruneExpired(this.#now());
    const hashes = this.#pending.get(path);
    if (hashes === undefined) return false;

    if (!hashes.has(diskHash)) return false;

    hashes.delete(diskHash);
    this.#size--;
    if (hashes.size === 0) {
      this.#pending.delete(path);
    }
    return true;
  }

  /**
   * Discard all pending entries for `path` (e.g. on file deletion or
   * when the engine determines the path is no longer being watched).
   */
  clear(path: string): void {
    const hashes = this.#pending.get(path);
    if (hashes === undefined) return;
    this.#size -= hashes.size;
    this.#pending.delete(path);
  }

  /** Expiry prevents a missed watcher event from suppressing a genuine later edit to old bytes. */
  #pruneExpired(now: number): void {
    const cutoff = now - this.#ttlMs;
    for (const [path, hashes] of this.#pending) {
      for (const [hash, recordedAt] of hashes) {
        if (recordedAt > cutoff) continue;
        hashes.delete(hash);
        this.#size--;
      }
      if (hashes.size === 0) this.#pending.delete(path);
    }
  }

  /** Bound missed-event growth globally; eviction happens on writes even if no event is consumed. */
  #evictGlobalOverflow(): void {
    while (this.#size > this.#maxTotal) {
      let oldestPath: string | undefined;
      let oldestHash: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [path, hashes] of this.#pending) {
        const first = hashes.entries().next().value;
        if (first !== undefined && first[1] < oldestAt) {
          oldestPath = path;
          oldestHash = first[0];
          oldestAt = first[1];
        }
      }
      if (oldestPath === undefined || oldestHash === undefined) return;
      const hashes = this.#pending.get(oldestPath);
      hashes?.delete(oldestHash);
      this.#size--;
      if (hashes?.size === 0) this.#pending.delete(oldestPath);
    }
  }
}
