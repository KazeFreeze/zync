/**
 * Pure suspend/resume decisions. The caller supplies wall-clock samples so tests stay deterministic
 * and this module remains independent of the DOM, Obsidian, and timer ownership.
 */

export function detectedResumeGap(
  previousTickAt: number | null,
  now: number,
  expectedIntervalMs: number,
  gapThresholdMs: number,
): boolean {
  if (previousTickAt === null) return false;
  return now - previousTickAt > expectedIntervalMs + gapThresholdMs;
}

export function canRunResumeCatchUp(
  lastRunAt: number | null,
  now: number,
  minRefireIntervalMs: number,
): boolean {
  if (lastRunAt === null || now < lastRunAt) return true;
  return now - lastRunAt >= minRefireIntervalMs;
}
