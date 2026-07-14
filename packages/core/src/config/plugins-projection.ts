/** The ids this device owns the enabled bit for: opted-in ∧ platform-allowed ∧ not-suppressed. */
export function managedSet(
  optIn: Set<string>,
  isDesktopOnly: Set<string>,
  suppressed: Set<string>,
  isMobile: boolean,
): Set<string> {
  const out = new Set<string>();
  for (const id of optIn) {
    if (suppressed.has(id)) continue;
    if (isMobile && isDesktopOnly.has(id)) continue;
    out.add(id);
  }
  return out;
}

/** Read-modify-write: managed ids present iff enabled; non-managed ids left exactly as-is. */
export function projectArray(
  current: string[],
  managed: Set<string>,
  enabled: (id: string) => boolean,
): string[] {
  const keep = current.filter((id) => !managed.has(id) || enabled(id)); // drop managed+disabled
  const present = new Set(keep);
  for (const id of managed) if (enabled(id) && !present.has(id)) keep.push(id); // add managed+enabled
  return keep;
}

/** For managed ids ONLY, enabled = membership in the array. Non-managed ids are omitted (ignored). */
export function ingestEnabled(array: string[], managed: Set<string>): Map<string, boolean> {
  const inArray = new Set(array);
  const out = new Map<string, boolean>();
  for (const id of managed) out.set(id, inArray.has(id));
  return out;
}

/** Order-insensitive equality (for the projection echo guard). */
export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}
