import type { Sha256, VaultPath } from "../ports.js";
import { sha256OfBytes } from "../hash.js";
import { configCategoryOf } from "./config-entry.js";

/** Recursively sort object keys; arrays/scalars unchanged. */
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * Canonical byte form of a JSON config file: parse -> sort keys -> re-serialize (minimal separators).
 * On any parse/serialize failure returns the ORIGINAL bytes (never throws).
 */
export function canonicalJsonBytes(bytes: Uint8Array): Uint8Array {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return new TextEncoder().encode(JSON.stringify(sortValue(parsed)));
  } catch {
    return bytes;
  }
}

/**
 * The single chokepoint for a config file's identity sha. plugin-data is canonicalized (so a cosmetic
 * re-save is a no-op); all other categories use raw bytes (opaque). Route EVERY config-file identity sha
 * (publish, local-change detect, bootstrap, blob-engine disk compare, divergence local-sha) through this.
 */
export function configIdentitySha(path: VaultPath, bytes: Uint8Array): Promise<Sha256> {
  const content = configCategoryOf(path) === "plugin-data" ? canonicalJsonBytes(bytes) : bytes;
  return sha256OfBytes(content);
}

/**
 * The bytes to STORE (blob) for a config file: canonical for plugin-data (so byte-identity == semantic
 * identity), raw for every other category. Invariant: configIdentitySha(path, bytes) ===
 * sha256OfBytes(configStoredBytes(path, bytes)).
 */
export function configStoredBytes(path: VaultPath, bytes: Uint8Array): Uint8Array {
  return configCategoryOf(path) === "plugin-data" ? canonicalJsonBytes(bytes) : bytes;
}
