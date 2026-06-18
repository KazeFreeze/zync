import type { Sha256, VaultPath } from "../ports.js";

/**
 * In-memory, read-through cache of `path -> sha256(diskBytes)` (`null` = confirmed-absent).
 *
 * WHY: a pre-populated vault's first sync re-scanned every live entry (vault.read + sha256) on every
 * one of the ~n relay-echoed reconcile passes -> O(n^2) reads (~2200/note on-device). This memoizes
 * the read+hash so an UNCHANGED file is hashed once, not once per pass.
 *
 * NOT PERSISTED. A fresh engine (new process / restart) gets an empty cache, so the startup full
 * reconcile re-reads disk -- which is what keeps the "edited while the plugin was disabled" case (no
 * vault event was ever delivered) correct.
 *
 * INVALIDATION CONTRACT (the engine wires all three): external changes -> `forget` (driven by
 * `vault.onEvent`); the engine's own writes -> `note` (driven by `EchoLedger.recordWrite`, which
 * immediately precedes every `vault.writeAtomic`); `vault.remove`/`vault.rename` -> invalidate.
 *
 * STALE-SAFE BY CONSTRUCTION: read ONLY at sites where a stale value is the safe direction -- the
 * materialize "already canonical? -> skip" gate (a stale value only MISSES a materialize, re-driven
 * later; it never authorizes a clobber -- the write path re-reads fresh) and clean-settle (advances
 * only the synced stamp, backstopped by the FRESH `pendingDocs` gate). The delete-deciding
 * `localHashOf` and the `pendingDocs` ground-truth deliberately do NOT use it.
 */
export class DiskHashCache {
  readonly #map = new Map<VaultPath, Sha256 | null>();
  readonly #read: (path: VaultPath) => Promise<Uint8Array | null>;
  readonly #hashBytes: (bytes: Uint8Array) => Promise<Sha256>;
  /**
   * Bumped on every mutating op (`note`/`forget`). A read-through `hash()` captures it before its
   * `await` and DECLINES to memoize if it changed during the await -- so an invalidation that races
   * in mid-read can never be overwritten by the now-stale value the in-flight read computed.
   *
   * `note()` bumps it too: a `note()` that lands while a `hash()` for the SAME path is in flight just
   * means that in-flight read won't memoize -- but `note()` already wrote the correct value, so the
   * next `hash()` is an immediate hit. The only observable effect is one wasted read, never a stale
   * cache entry.
   */
  #epoch = 0;

  constructor(deps: {
    read: (path: VaultPath) => Promise<Uint8Array | null>;
    hashBytes: (bytes: Uint8Array) => Promise<Sha256>;
  }) {
    this.#read = deps.read;
    this.#hashBytes = deps.hashBytes;
  }

  /** Read-through: cached value, else read+hash, memoize, return. `null` = no file at `path`. */
  async hash(path: VaultPath): Promise<Sha256 | null> {
    const cached = this.#map.get(path);
    if (cached !== undefined) return cached;
    const epoch = this.#epoch;
    const bytes = await this.#read(path);
    const h = bytes === null ? null : await this.#hashBytes(bytes);
    if (this.#epoch === epoch) this.#map.set(path, h);
    return h;
  }

  /** Warm-set a KNOWN post-write hash (or `null` for a known-removed path). */
  note(path: VaultPath, hash: Sha256 | null): void {
    this.#map.set(path, hash);
    this.#epoch++;
  }

  /** Drop the memo for `path` so the next `hash()` re-reads disk. */
  forget(path: VaultPath): void {
    this.#map.delete(path);
    this.#epoch++;
  }
}
