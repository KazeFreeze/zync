/**
 * Structural echo check for plugin-data (H3-v2). A plugin re-normalizing its settings on load only
 * ADDS default keys (or rewrites identical bytes); a genuine user edit CHANGES an existing value. This
 * decides "is `local` a benign superset of `materialized`?" — true ⇒ suppress (a normalization),
 * false ⇒ publish (a value changed / a key was removed / a structural change). Pure; no timing.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep structural equality: objects (order-insensitive), arrays (order-sensitive), primitives. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * True iff `local` is a benign superset of `materialized`: at every object level `local` contains all of
 * `materialized`'s non-noisy keys with benign-superset values, and may ADD keys. Arrays and primitives
 * must be deep-equal (a changed array or scalar is a real edit). Noisy keys are ignored in the compare.
 */
export function isBenignSuperset(
  materialized: unknown,
  local: unknown,
  noisyKeys: ReadonlySet<string>,
): boolean {
  if (isPlainObject(materialized) && isPlainObject(local)) {
    for (const k of Object.keys(materialized)) {
      if (noisyKeys.has(k)) continue;
      if (!(k in local)) return false;
      if (!isBenignSuperset(materialized[k], local[k], noisyKeys)) return false;
    }
    return true;
  }
  return deepEqual(materialized, local);
}
