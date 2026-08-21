import { canonicalJsonBytes } from "./canonical.js";
import { pluginSyncPolicy } from "./plugin-sync-policy.js";

function plainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : null;
}

function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    return plainObject(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/**
 * Build the bytes this device should materialize for plugin data with device-owned top-level keys.
 * Incoming owns every other key. A locally absent device-owned key deliberately falls through to
 * incoming, which gives a fresh device the peer/default value. `null` means ordinary materialization.
 */
export function mergeDeviceLocalPluginData(
  pluginId: string,
  incomingBytes: Uint8Array,
  localBytes: Uint8Array,
): Uint8Array | null {
  const policy = pluginSyncPolicy(pluginId);
  if (policy.kind !== "sync-except" || policy.deviceLocalKeys.size === 0) return null;
  const incoming = parseObject(incomingBytes);
  const local = parseObject(localBytes);
  if (incoming === null || local === null) return null;

  const merged = { ...incoming };
  for (const key of policy.deviceLocalKeys) {
    if (Object.prototype.hasOwnProperty.call(local, key)) merged[key] = local[key];
  }
  return canonicalJsonBytes(new TextEncoder().encode(JSON.stringify(merged)));
}
