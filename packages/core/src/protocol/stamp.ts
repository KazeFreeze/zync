import type { DeviceId, Sha256, Stamp } from "../ports.js";

/**
 * Content stamps (0b-2 §B). A stamp is `${sha256(text)}:${deviceId}` — a content
 * hash plus the authoring device. The hash is the IDENTITY of the content; the
 * `:deviceId` suffix is provenance/tiebreak metadata only.
 *
 * THE KEYSTONE RULE: every comparison uses the HASH PART only. The device suffix
 * is NEVER an equality input. Two devices that converge to byte-identical content
 * produce stamps with the same hash but different suffixes — if equality compared
 * the whole string they would look perpetually unequal and `waitConverged` would
 * hang (the NEW-1 anti-hang case). Compare via {@link stampsEqual}, not `===`.
 */

/** Build a stamp from a content hash + the authoring device. */
export function makeStamp(sha: Sha256, deviceId: DeviceId): Stamp {
  return `${sha}:${deviceId}`;
}

/**
 * Extract the content-hash part of a stamp. Uses `lastIndexOf(":")` (not
 * `indexOf`) so a hash that ever contained a colon stays intact — sha256 hex
 * never will, but this keeps the split defensive. A stamp with no colon is
 * treated as a bare hash.
 */
export function stampHash(stamp: Stamp): string {
  const i = stamp.lastIndexOf(":");
  return i < 0 ? stamp : stamp.slice(0, i);
}

/**
 * Equality on the HASH PART only (see module doc). `null` models "no stamp yet";
 * two nulls are equal, a null and a stamp are not.
 */
export function stampsEqual(a: Stamp | null, b: Stamp | null): boolean {
  if (a === null || b === null) return a === b;
  return stampHash(a) === stampHash(b);
}
