/**
 * Per-path publish-rate circuit-breaker (H3-v2). A pathological plugin (volatile value-changer not
 * covered by the noisy list, or an unforeseen bug) could republish its data.json in a runaway loop that
 * inflates dataVersion, churns the relay, and drains mobile battery. This bounds + detects it: more than
 * LOOP_MAX_PUBLISHES distinct-value publishes of one path within LOOP_WINDOW_MS trips the breaker, after
 * which publishes for that path are suppressed (sticky for the session). Pure; injected clock.
 */
export const LOOP_WINDOW_MS = 30_000;
export const LOOP_MAX_PUBLISHES = 6;

export class ConfigLoopBreaker {
  private readonly stamps = new Map<string, number[]>();
  private readonly tripped = new Set<string>();

  constructor(private readonly d: { now: () => number }) {}

  /** Call BEFORE publishing `path`. false ⇒ breaker is tripped → the caller must suppress the publish. */
  allow(path: string): boolean {
    return !this.tripped.has(path);
  }

  /** Call AFTER a real (map-changing) publish. Returns true iff THIS call just tripped the breaker. */
  record(path: string): boolean {
    const now = this.d.now();
    const arr = (this.stamps.get(path) ?? []).filter((t) => now - t < LOOP_WINDOW_MS);
    arr.push(now);
    this.stamps.set(path, arr);
    if (arr.length > LOOP_MAX_PUBLISHES && !this.tripped.has(path)) {
      this.tripped.add(path);
      return true;
    }
    return false;
  }

  /** Re-arm a path (restart is implicit via a fresh instance; used by an explicit re-include). */
  reset(path: string): void {
    this.tripped.delete(path);
    this.stamps.delete(path);
  }
}
