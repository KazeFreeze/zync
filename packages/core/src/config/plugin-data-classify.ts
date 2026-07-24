import type { Sha256 } from "../ports.js";
import { isBenignSuperset } from "./benign-normalization.js";

export type EchoDecision = "suppress" | "adopt-normalized" | "publish";

/**
 * Well-known volatile/state key names whose value differences are ignored in the superset check (cheap
 * insurance for the rare volatile plugin). Deliberately minimal — value-churning STATE plugins are
 * handled by exclusion + the loop-breaker, not by growing this list.
 */
export const NOISY_DATA_KEYS: ReadonlySet<string> = new Set([
  "lastRun",
  "lastChecked",
  "lastSaved",
  "lastUpdated",
  "lastModified",
  "timestamp",
]);

/** Parse config bytes as JSON; undefined on null/invalid (caller treats undefined as "cannot verify"). */
export function tryParseJson(bytes: Uint8Array | null | undefined): unknown {
  if (bytes === null || bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Content-based echo decision for a local plugin-data change. S=canonical sha of the just-saved bytes,
 * M=config-map sha, R=durable normalizedSha. `materialized`/`local` are the parsed JSON of the map value
 * and the new bytes (undefined if unavailable/unparseable → we cannot verify a normalization → publish).
 */
export function classifyPluginDataChange(args: {
  s: Sha256;
  m: Sha256 | null;
  r: Sha256 | null;
  materialized: unknown;
  local: unknown;
  noisyKeys: ReadonlySet<string>;
}): EchoDecision {
  if (args.s === args.m) return "suppress"; // canonical no-op / exact echo
  if (args.r !== null && args.s === args.r) return "suppress"; // known normalization (repeat)
  if (
    args.materialized !== undefined &&
    args.local !== undefined &&
    isBenignSuperset(args.materialized, args.local, args.noisyKeys)
  ) {
    return "adopt-normalized"; // only-added-defaults etc. → learn R, don't publish
  }
  return "publish"; // a real value changed, or we can't verify → publish
}
