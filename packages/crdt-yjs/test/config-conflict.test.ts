/**
 * Config-conflict resolution: resolveConfigConflict "keep-theirs" path.
 *
 * Constructs a config-enabled SyncEngine (with a FakeConfigPort + FakeBlobStore),
 * manually injects a `config-file` inbox entry, and verifies that
 * `resolveConfigConflict(id, "keep-theirs")` —
 *   (a) writes the remote bytes to disk via config.writeAtomic (echo-guarded),
 *   (b) publishes the remote sha to the config CRDT map so peers converge,
 *   (c) tombstones the inbox entry (removed from list()).
 */
import { afterEach, describe, expect, it } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig, sha256OfBytes } from "@zync/core";
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

const vp = (s: string): VaultPath => s as VaultPath;

// Config path inside the allow-listed zone so configCategoryOf returns "themes".
const CONFIG_PATH = vp(".obsidian/themes/my-theme.css");

// ── minimal in-test ConfigPort ────────────────────────────────────────────────

function makeConfigPort(): {
  port: ConfigPort;
  writes: { path: VaultPath; data: Uint8Array }[];
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  const writes: { path: VaultPath; data: Uint8Array }[] = [];

  const port: ConfigPort = {
    read: (p): Promise<Uint8Array | null> => Promise.resolve(files.get(p) ?? null),
    writeAtomic: (p, data): Promise<void> => {
      files.set(p, data);
      writes.push({ path: p, data });
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
  return { port, writes, files };
}

// ── structural subtype for accessing private indexDoc ─────────────────────────
// SyncEngine.indexDoc is private. Using "as unknown as" to a narrow structural
// interface avoids eslint no-explicit-any while keeping the assertion typed.
interface EngineWithConfigMap {
  indexDoc: null | {
    getMap(name: string): {
      get(key: string): { sha256: string; size: number } | undefined;
    };
  };
}

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

// ── full engine factory ───────────────────────────────────────────────────────

interface Setup {
  engine: SyncEngine;
  blobStore: FakeBlobStore;
  configPort: ReturnType<typeof makeConfigPort>;
  engineState: MemEngineState;
}

function makeSetup(): Setup {
  const bus = new InProcessBus();
  const blobStore = new FakeBlobStore();
  const configPort = makeConfigPort();
  const engineState = new MemEngineState();

  const ports: EnginePorts = {
    vault: new FakeVault(),
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs: blobStore,
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity("dev-a"),
    engineState,
    config: configPort.port,
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), blobStore, configPort, engineState };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("resolveConfigConflict", () => {
  let engine: SyncEngine | undefined;

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  it("keep-theirs: writes remote bytes to disk, publishes remote sha to config map, resolves entry", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    const localBytes = new TextEncoder().encode("/* local theme */");
    const theirBytes = new TextEncoder().encode("/* their theme */");
    const localSha = await sha256OfBytes(localBytes);
    const remoteSha = await sha256OfBytes(theirBytes);

    // Pre-seed: the remote bytes must be in the blob store (as if published by the remote device).
    await setup.blobStore.put(remoteSha, theirBytes);
    // Pre-seed: local bytes available in config port (simulates the local file state).
    setup.configPort.files.set(CONFIG_PATH, localBytes);

    const id = `config-file:${CONFIG_PATH}:${localSha.slice(0, 8)}`;
    engine.inbox.add({
      id,
      kind: "config-file",
      path: CONFIG_PATH,
      localSha,
      remoteSha,
      localSize: localBytes.length,
      remoteSize: theirBytes.length,
      detail: "Config file changed on another device.",
    });

    await engine.resolveConfigConflict(id, "keep-theirs");

    // (a) disk received the remote bytes via config.writeAtomic.
    expect(setup.configPort.writes).toHaveLength(1);
    expect(setup.configPort.writes[0]?.path).toBe(CONFIG_PATH);
    expect(setup.configPort.writes[0]?.data).toEqual(theirBytes);

    // (b) config CRDT map entry now carries the remote sha so peers converge.
    const map = (engine as unknown as EngineWithConfigMap).indexDoc?.getMap("config");
    const mapEntry = map?.get(CONFIG_PATH);
    expect(mapEntry?.sha256).toBe(remoteSha);
    expect(mapEntry?.size).toBe(theirBytes.length);

    // (c) inbox entry is tombstoned — absent from list().
    expect(engine.inbox.list().find((e) => e.id === id)).toBeUndefined();

    // (d) config base updated to the winner sha — prevents repeat conflicts on the next remote push.
    expect(await setup.engineState.getConfigBase(CONFIG_PATH)).toBe(remoteSha);
  });

  it("idempotent: re-calling with an already-resolved id is a no-op", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // No entry exists for this id → idempotent early return, no write.
    await engine.resolveConfigConflict("config-file:no-such-path:00000000", "keep-mine");
    expect(setup.configPort.writes).toHaveLength(0);
  });
});

describe("onConfigDivergence — config base tracking", () => {
  let engine: SyncEngine | undefined;

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  it("normal update accepted: local sha equals base -> no inbox entry raised", async () => {
    /**
     * Scenario: device materialized v1 from remote (base = shaV1). Disk still holds shaV1.
     * Remote pushes v2 (expectedSha = shaV2). local == base -> NOT a real conflict -> accept.
     */
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    const v1Bytes = new TextEncoder().encode("/* v1 theme */");
    const v2Bytes = new TextEncoder().encode("/* v2 theme */");
    const shaV1 = await sha256OfBytes(v1Bytes);
    const shaV2 = await sha256OfBytes(v2Bytes);

    // Pre-seed: v2 bytes available in blob store (remote published them).
    await setup.blobStore.put(shaV2, v2Bytes);
    // Simulate: this device had previously materialized v1 from remote.
    await setup.engineState.setConfigBase(CONFIG_PATH, shaV1);
    // Disk holds v1 (unchanged since materialization).
    setup.configPort.files.set(CONFIG_PATH, v1Bytes);

    // Manually invoke onConfigDivergence via the private seam through the BlobEngine
    // onDivergence hook path. We drive it directly via the engine's inbox check:
    // inject a fake divergence by calling the method that would be called when the
    // blob engine detects disk != expectedSha.
    // Use the engine's inbox as the observable: if no config-file entry is added, the update was accepted.
    const inboxBefore = engine.inbox.list().filter((e) => e.kind === "config-file").length;

    // Directly call the private method via casting to any.
    const result = await (
      engine as unknown as {
        onConfigDivergence: (
          p: typeof CONFIG_PATH,
          i: { localSha: typeof shaV1; expectedSha: typeof shaV2 },
        ) => Promise<boolean>;
      }
    ).onConfigDivergence(CONFIG_PATH, { localSha: shaV1, expectedSha: shaV2 });

    // local == base -> divergence should be accepted (return false, no inbox entry).
    expect(result).toBe(false);
    const inboxAfter = engine.inbox.list().filter((e) => e.kind === "config-file").length;
    expect(inboxAfter).toBe(inboxBefore);
  });

  it("true conflict raised: local sha differs from base -> inbox entry is raised", async () => {
    /**
     * Scenario: base = shaV1, but local disk was independently edited to shaLocalEdit.
     * Remote pushes v2 (expectedSha = shaV2). local != base -> real conflict -> raise inbox.
     */
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    const v1Bytes = new TextEncoder().encode("/* v1 theme */");
    const localEditBytes = new TextEncoder().encode("/* local edit */");
    const v2Bytes = new TextEncoder().encode("/* v2 theme */");
    const shaV1 = await sha256OfBytes(v1Bytes);
    const shaLocalEdit = await sha256OfBytes(localEditBytes);
    const shaV2 = await sha256OfBytes(v2Bytes);

    // Pre-seed: v2 bytes available in blob store.
    await setup.blobStore.put(shaV2, v2Bytes);
    // Base is v1 (last materialized from remote).
    await setup.engineState.setConfigBase(CONFIG_PATH, shaV1);
    // Disk holds the local edit (different from base).
    setup.configPort.files.set(CONFIG_PATH, localEditBytes);

    const inboxBefore = engine.inbox.list().filter((e) => e.kind === "config-file").length;

    const result = await (
      engine as unknown as {
        onConfigDivergence: (
          p: typeof CONFIG_PATH,
          i: { localSha: typeof shaLocalEdit; expectedSha: typeof shaV2 },
        ) => Promise<boolean>;
      }
    ).onConfigDivergence(CONFIG_PATH, { localSha: shaLocalEdit, expectedSha: shaV2 });

    // local != base -> real conflict -> return true, inbox entry raised.
    expect(result).toBe(true);
    const inboxAfter = engine.inbox.list().filter((e) => e.kind === "config-file").length;
    expect(inboxAfter).toBe(inboxBefore + 1);

    const entry = engine.inbox
      .list()
      .find((e) => e.kind === "config-file" && e.path === CONFIG_PATH);
    expect(entry).toBeDefined();
  });
});
