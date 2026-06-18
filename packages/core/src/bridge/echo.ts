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
  readonly #pending = new Map<string, Set<string>>();

  /**
   * Optional hook fired AFTER every {@link recordWrite}, with the recorded `(path, hash)`. The engine
   * wires this to its `DiskHashCache.note` so a KNOWN post-write hash keeps the cache warm in the
   * window before the (async, on real Obsidian) watcher event lands. Default: no-op.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  onRecord: (path: string, hash: string) => void = () => {};

  /**
   * Record that we are about to write `hash` to `path`.
   * May be called multiple times before the corresponding fs events arrive.
   */
  recordWrite(path: string, hash: string): void {
    const existing = this.#pending.get(path);
    if (existing !== undefined) {
      existing.add(hash);
    } else {
      this.#pending.set(path, new Set([hash]));
    }
    this.onRecord(path, hash);
  }

  /**
   * Returns `true` and consumes the entry if `diskHash` matches one of our
   * recorded intended hashes for `path`; otherwise returns `false` leaving
   * any other pending entries intact.
   */
  isEcho(path: string, diskHash: string): boolean {
    const hashes = this.#pending.get(path);
    if (hashes === undefined) return false;

    if (!hashes.has(diskHash)) return false;

    hashes.delete(diskHash);
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
    this.#pending.delete(path);
  }
}
