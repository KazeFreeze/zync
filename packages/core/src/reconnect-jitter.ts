/**
 * Deterministic per-device reconnect-heal jitter — a pure function of the deviceId.
 *
 * After a mass relay/state reset, many devices reconnect and each runs a full catch-up into a fresh
 * relay at once (a load spike + concurrent-insert hazard). Staggering the first self-heal arm spreads
 * that. We derive the offset from the deviceId with a small FNV-1a hash — NOT `Math.random()` — so
 * `@zync/core` stays RNG-free (pure/portable) and the value is deterministic + testable, while
 * distinct deviceIds still land on distinct offsets (de-synchronizing the herd).
 *
 * @param deviceId  this device's stable id
 * @param maxMs     jitter ceiling; `0` disables jitter (returns 0) — used by tests for determinism
 * @returns an integer in `[0, maxMs)` (or 0 when maxMs <= 0)
 */
export function reconnectHealJitterMs(deviceId: string, maxMs: number): number {
  if (maxMs <= 0) return 0;
  // FNV-1a 32-bit over the deviceId's UTF-16 code units — small, allocation-free, deterministic.
  let h = 0x811c9dc5;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % maxMs;
}
