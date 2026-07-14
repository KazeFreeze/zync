/**
 * Version assignment on publish (plugin-data version-aware convergence — LEAN).
 *
 * Design: docs/superpowers/specs/2026-07-11-zync-plugin-data-version-tiebreak-design.md
 *
 * A plain publish of a plugin-data (data.json) path is a NEW local edit, so ConfigChannel.publish
 * bumps the per-path numeric edit-version (localVersion+1), writes it onto the ConfigEntry as
 * `dataVersion`, and persists the new version via the engine-state seam. Two devices editing off the
 * same synced version therefore both emit version+1 — a true tie, later resolved by canonical-sha at
 * divergence. This covers Testing item 7 of the design.
 *
 * Kept in a SEPARATE file (not config-channel.test.ts) so it stays lint-clean.
 */
import { describe, it, expect } from "vitest";
import { ConfigChannel, type ConfigChannelDeps } from "./config-channel.js";
import { canonicalJsonBytes } from "./canonical.js";
import type {
  BlobStorePort,
  ConfigPort,
  CrdtMap,
  IdentityPort,
  Unsubscribe,
  VaultPath,
} from "../ports.js";
import type { ConfigEntry } from "./config-entry.js";
import type { EchoLedger } from "../bridge/echo.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dataPath = (id: string): VaultPath => `.obsidian/plugins/${id}/data.json` as VaultPath;

/** Minimal in-memory CrdtMap. */
function memMap<V>(): CrdtMap<V> {
  const m = new Map<string, V>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
    },
    delete: (k) => {
      m.delete(k);
    },
    entries: () => [...m.entries()],
    observe: (): Unsubscribe => () => undefined,
  };
}

/** In-memory blob store. */
function memBlobStore(): BlobStorePort {
  const blobs = new Map<string, Uint8Array>();
  return {
    has: (sha) => Promise.resolve(blobs.has(sha)),
    put: (sha, bytes) => {
      blobs.set(sha, bytes);
      return Promise.resolve();
    },
    get: (sha) => Promise.resolve(blobs.get(sha) ?? new Uint8Array()),
  };
}

const identity: IdentityPort = {
  deviceId: () => "d" as ReturnType<IdentityPort["deviceId"]>,
  deviceName: () => "dev",
};

const echo = {
  recordWrite: () => undefined,
  isEcho: () => false,
  clear: () => undefined,
} as unknown as EchoLedger;

/** A channel whose configPort has NO sibling manifest (so no `version` string is stamped). */
function makeChannel(): {
  ch: ConfigChannel;
  configMap: CrdtMap<ConfigEntry>;
  versions: Map<string, number>;
} {
  const configMap = memMap<ConfigEntry>();
  const configPort: ConfigPort = {
    read: () => Promise.resolve(null),
    writeAtomic: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    onChange: (): Unsubscribe => () => undefined,
    rescan: () => Promise.resolve(),
    close: () => undefined,
  };
  const versions = new Map<string, number>();
  const engineState: NonNullable<ConfigChannelDeps["engineState"]> = {
    getConfigLocalVersion: (p) => Promise.resolve(versions.get(p) ?? 0),
    setConfigLocalVersion: (p, v) => {
      versions.set(p, v);
      return Promise.resolve();
    },
  };
  const ch = new ConfigChannel({
    config: configMap,
    blobStore: memBlobStore(),
    configPort,
    identity,
    echo,
    enabledCategories: { themes: true, snippets: true, plugins: true, "plugin-data": true },
    engineState,
    now: () => 0,
  });
  return { ch, configMap, versions };
}

describe("ConfigChannel.publish — plugin-data version assignment", () => {
  it("(7) stamps dataVersion = localVersion+1 and persists it", async () => {
    const { ch, configMap, versions } = makeChannel();
    const p = dataPath("dv");

    await ch.publish(p, enc(`{"a":1}`));
    expect(configMap.get(p)?.dataVersion).toBe(1); // localVersion 0 -> entry version 1
    expect(versions.get(p)).toBe(1); // persisted for the next edit

    // A subsequent DISTINCT edit bumps again: 1 -> 2.
    await ch.publish(p, enc(`{"a":2}`));
    expect(configMap.get(p)?.dataVersion).toBe(2);
    expect(versions.get(p)).toBe(2);

    // Sanity: the stored entry is the canonical value.
    const entry = configMap.get(p);
    expect(entry?.category).toBe("plugin-data");
  });

  it("(7b) two publishers off the same local version both emit version+1 (a true tie)", async () => {
    const a = makeChannel();
    const b = makeChannel();
    const p = dataPath("dv");
    // Both devices sit at localVersion 0 and each authors its own value.
    await a.ch.publish(p, enc(`{"pick":"alpha"}`));
    await b.ch.publish(p, enc(`{"pick":"bravo"}`));
    expect(a.configMap.get(p)?.dataVersion).toBe(1);
    expect(b.configMap.get(p)?.dataVersion).toBe(1); // same version -> resolved by hash at divergence
  });

  it("(7c) a cosmetic (canonically-identical) re-save does NOT bump the version", async () => {
    const { ch, configMap, versions } = makeChannel();
    const p = dataPath("dv");

    await ch.publish(p, enc(`{"a":1,"b":2}`));
    expect(versions.get(p)).toBe(1);
    const sha1 = configMap.get(p)?.sha256;

    // Different key order / whitespace, same canonical value -> churn guard returns before the bump.
    await ch.publish(p, enc(`{ "b": 2, "a": 1 }`));
    expect(configMap.get(p)?.sha256).toBe(sha1);
    expect(configMap.get(p)?.dataVersion).toBe(1); // unchanged
    expect(versions.get(p)).toBe(1);
    // The stored canonical bytes are stable.
    expect(canonicalJsonBytes(enc(`{ "b": 2, "a": 1 }`))).toEqual(
      canonicalJsonBytes(enc(`{"a":1,"b":2}`)),
    );
  });
});
