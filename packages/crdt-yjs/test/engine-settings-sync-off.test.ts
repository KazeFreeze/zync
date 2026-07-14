/**
 * Slice 3b Batch A — settingsSyncOff() reader
 *
 * Verifies that `settingsSyncOff()` returns the plugin ids whose settings-sync is
 * explicitly OFF (the default is ON = absent from the map). Mirrors the style of
 * the engine-plugins.test.ts suite: single-engine, config-enabled, post-start calls.
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

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

function makeConfigPort(): ConfigPort {
  const files = new Map<string, Uint8Array>();
  return {
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
}

function makeEngine(): SyncEngine {
  const bus = new InProcessBus();
  const ports: EnginePorts = {
    vault: new FakeVault(),
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity("dev-a"),
    engineState: new MemEngineState(),
    config: makeConfigPort(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
    configCategories: { themes: true, snippets: true, plugins: true, "plugin-data": true },
  };
  return new SyncEngine(ports, config);
}

describe("settingsSyncOff() reader (Slice 3b)", () => {
  let engine: SyncEngine | undefined;

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  it("includes a plugin id after setPluginSettingsSync(id, false)", async () => {
    engine = makeEngine();
    await engine.start();

    engine.setPluginSettingsSync("dv", false);

    expect(engine.settingsSyncOff()).toContain("dv");
  });

  it("does NOT include a plugin that was never set (default is ON = absent)", async () => {
    engine = makeEngine();
    await engine.start();

    // "dv" was never set — default is ON (absent from the map).
    expect(engine.settingsSyncOff()).not.toContain("dv");
  });

  it("does NOT include a plugin after setPluginSettingsSync(id, true) (re-enabled = back to ON)", async () => {
    engine = makeEngine();
    await engine.start();

    engine.setPluginSettingsSync("dv", false);
    // Confirm it is off first.
    expect(engine.settingsSyncOff()).toContain("dv");

    // Now re-enable settings sync.
    engine.setPluginSettingsSync("dv", true);
    expect(engine.settingsSyncOff()).not.toContain("dv");
  });
});
