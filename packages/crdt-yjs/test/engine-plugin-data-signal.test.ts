/**
 * Slice 3b Batch A — engine signal: onPluginDataMaterialized(id)
 *
 * Verifies that the engine fires `onPluginDataMaterialized(id)` exactly when a
 * plugin-data (data.json) file materializes for a DESIRED-ACTIVE plugin, and does
 * NOT fire for:
 *   - a plugin NOT in desiredActivePlugins() (not opted-in or not enabled)
 *   - a `plugins` (code bundle) materialize
 *
 * Uses a two-engine InProcessBus setup mirroring engine-blob-sync.test.ts / engine-plugins.test.ts.
 * Device A opts-in + publishes data.json via writePluginData.
 * Device B (opted-in + enabled + local manifest installed) materializes it.
 *
 * The PluginDataVersionGate on B holds data.json until B has a local manifest whose
 * version is >= the stamped writer version. Since A has no manifest (no version stamped),
 * B just needs any manifest present (version "1.0.0" satisfies: writer=undefined -> gate
 * releases because local !== undefined && compareVersions(undefined, "1.0.0") = -1 <= 0).
 */
import { afterEach, describe, expect, it } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { ConfigPort, DeviceId, IdentityPort, Unsubscribe, VaultPath } from "@zync/core";
import {
  FakeBlobStore,
  FakeClock,
  FakeDocStore,
  FakeVault,
  InProcessBus,
  MemEngineState,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const vp = (s: string): VaultPath => s as VaultPath;

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

/**
 * Minimal ConfigPort backed by an in-memory file map.
 * `files` is exposed so tests can pre-seed manifests.
 */
function makeConfigPort(): {
  port: ConfigPort;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  const port: ConfigPort = {
    read: (p): Promise<Uint8Array | null> => Promise.resolve(files.get(p) ?? null),
    writeAtomic: (p, data): Promise<void> => {
      files.set(p, data);
      return Promise.resolve();
    },
    remove: (p): Promise<void> => {
      files.delete(p);
      return Promise.resolve();
    },
    list: (): Promise<{ path: VaultPath; size: number }[]> => Promise.resolve([]),
    onChange: (): Unsubscribe => () => undefined,
    rescan: (): Promise<void> => Promise.resolve(),
    close: (): void => undefined,
  };
  return { port, files };
}

interface Device {
  engine: SyncEngine;
  configFiles: Map<string, Uint8Array>;
}

/**
 * Build one engine with `configCategories` including `plugin-data`.
 * `sharedBlobs` is the blob store shared across devices (content-addressed relay).
 * Set `eager=true` on the RECEIVING device so the BlobEngine auto-materializes synced blobs.
 */
function makeDevice(
  bus: InProcessBus,
  deviceId: string,
  sharedBlobs: FakeBlobStore,
  opts: { eager?: boolean } = {},
): Device {
  const config = makeConfigPort();
  const ports: EnginePorts = {
    vault: new FakeVault(),
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs: sharedBlobs,
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(deviceId),
    engineState: new MemEngineState(),
    config: config.port,
  };
  const cfg: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
    configCategories: { themes: true, snippets: true, plugins: true, "plugin-data": true },
    blobPolicy: opts.eager === true ? "eager" : "lazy",
  };
  return { engine: new SyncEngine(ports, cfg), configFiles: config.files };
}

/** Poll until `cond` is truthy, or throw after `maxTicks` microtask turns. */
async function waitFor(cond: () => boolean, maxTicks = 300): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitFor: condition not met within tick budget");
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("onPluginDataMaterialized engine signal (Slice 3b)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("fires (id) when a data.json materializes for a desired-active plugin on the receiving device", async () => {
    const sharedBlobs = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", sharedBlobs);
    b = makeDevice(bus, "dev-b", sharedBlobs, { eager: true });

    // Pre-seed B's config port with a local manifest for "dv" so the PluginDataVersionGate
    // releases (writer version = undefined <= local "1.0.0" → not held).
    b.configFiles.set(
      ".obsidian/plugins/dv/manifest.json",
      enc(JSON.stringify({ id: "dv", name: "Dataview", version: "1.0.0" })),
    );

    await a.engine.start();
    await b.engine.start();

    // A: opt in + enable the plugin so it is desired-active (needed for A to publish data.json).
    await a.engine.setPluginOptIn("dv", true);
    a.engine.setPluginEnabled("dv", true);

    // B: same opt-in state will sync over CRDT; explicitly set enabled on B too, and confirm desired-active.
    b.engine.setPluginEnabled("dv", true);
    // Wait for opt-in CRDT to propagate to B.
    await waitFor(() => b.engine.desiredActivePlugins().includes("dv"));

    // Collect signal ids fired on B.
    const fired: string[] = [];
    const unsub = b.engine.onPluginDataMaterialized((id) => fired.push(id));

    // A publishes data.json — this goes into the shared blob store + CRDT config map.
    await a.engine.writePluginData("dv", enc('{"setting":true}'));

    // Wait for B to materialize the data.json and fire the callback.
    await waitFor(() => fired.length > 0);

    expect(fired).toContain("dv");

    unsub();
  });

  it("does NOT fire for a plugin NOT in desiredActivePlugins (opted-in but enabled=false)", async () => {
    const sharedBlobs = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", sharedBlobs);
    b = makeDevice(bus, "dev-b", sharedBlobs, { eager: true });

    // B has a manifest so the PluginDataVersionGate releases.
    b.configFiles.set(
      ".obsidian/plugins/dv/manifest.json",
      enc(JSON.stringify({ id: "dv", name: "Dataview", version: "1.0.0" })),
    );

    await a.engine.start();
    await b.engine.start();

    // A: opt-in only (no setPluginEnabled). The PluginGate allows publish (only checks optIn).
    // pluginsEnabled is a shared CRDT: since neither device calls setPluginEnabled("dv", true),
    // dv is absent from the enabled map on both → NOT desired-active on B.
    await a.engine.setPluginOptIn("dv", true);

    // Wait for opt-in CRDT to propagate to B.
    await waitFor(() => b.engine.listPluginOptIn().some((p) => p.id === "dv" && p.optIn));
    // Confirm dv is NOT desired-active on B (no enabled entry).
    expect(b.engine.desiredActivePlugins()).not.toContain("dv");

    const fired: string[] = [];
    b.engine.onPluginDataMaterialized((id) => fired.push(id));

    await a.engine.writePluginData("dv", enc('{"setting":false}'));

    // Give the system enough ticks to settle — if cb were going to fire, it would fire.
    await b.engine.whenIdle();
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveLength(0);
  });

  it("does NOT fire the data cb when a plugins (code bundle) file materializes", async () => {
    const sharedBlobs = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", sharedBlobs);
    b = makeDevice(bus, "dev-b", sharedBlobs, { eager: true });

    b.configFiles.set(
      ".obsidian/plugins/dv/manifest.json",
      enc(JSON.stringify({ id: "dv", name: "Dataview", version: "1.0.0" })),
    );

    await a.engine.start();
    await b.engine.start();

    await a.engine.setPluginOptIn("dv", true);
    a.engine.setPluginEnabled("dv", true);
    b.engine.setPluginEnabled("dv", true);
    await waitFor(() => b.engine.desiredActivePlugins().includes("dv"));

    const dataCbFired: string[] = [];
    b.engine.onPluginDataMaterialized((id) => dataCbFired.push(id));

    // Publish a `plugins`-category (code bundle) file — main.js. This should fire
    // onPluginCodeMaterialized, NOT onPluginDataMaterialized.
    const mainJsPath = vp(".obsidian/plugins/dv/main.js");
    const mainJsBytes = enc("// plugin code");
    a.configFiles.set(mainJsPath, mainJsBytes);
    // Publish via setPluginOptIn bundle publishing by directly calling configChannel.
    // Since A already opted in, re-calling setPluginOptIn would be a no-op for the CRDT
    // but republishes the bundle files. We use writePluginData equivalent for the code file
    // by triggering via the config port + publish:
    // The simplest way: re-opt-in A (idempotent on CRDT; republishes all bundle files).
    await a.engine.setPluginOptIn("dv", true);

    // Wait for B to process all pending work.
    await b.engine.whenIdle();
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));

    // The DATA signal must not have fired for a code file.
    expect(dataCbFired).not.toContain("dv");
  });
});
