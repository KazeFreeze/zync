/**
 * Slice 2b engine-level tests for the on-device apply seams:
 *   - desiredActivePlugins(): the managed ∧ enabled ∧ ¬suppressed ∧ platform-allowed set.
 *   - isManaged(): "Zync owns this plugin's activation" = optIn ∧ platform-allowed ∧ id≠"zync"
 *     (INTENTIONALLY does NOT exclude suppressed — so a suppressed running plugin can be
 *     live-disabled; see engine.ts isManaged doc + D6).
 *
 * These live in the crdt-yjs test package because they need a fully-started SyncEngine (@zync/core
 * has no fake CrdtProvider; the real one is YjsCrdtProvider). A ConfigPort is wired so that
 * setPluginOptIn can read the plugin manifests and populate `pluginsMeta.isDesktopOnly` — the
 * only way isDesktopOnly enters the shared meta map in production.
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

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

/**
 * A minimal ConfigPort that serves per-plugin manifests so setPluginOptIn can resolve
 * isDesktopOnly. `manifests` maps a plugin id → its manifest.isDesktopOnly flag.
 */
function makeConfigPort(manifests: Record<string, { isDesktopOnly: boolean }>): ConfigPort {
  const files = new Map<string, Uint8Array>();
  for (const [id, m] of Object.entries(manifests)) {
    files.set(
      `.obsidian/plugins/${id}/manifest.json`,
      enc(JSON.stringify({ id, name: id, isDesktopOnly: m.isDesktopOnly })),
    );
  }
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

interface MakeOpts {
  isMobile?: boolean;
  manifests?: Record<string, { isDesktopOnly: boolean }>;
}

function makeEngine(opts: MakeOpts = {}): SyncEngine {
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
    config: makeConfigPort(opts.manifests ?? {}),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
    configCategories: { themes: true, snippets: true, plugins: true },
    isMobile: opts.isMobile ?? false,
  };
  return new SyncEngine(ports, config);
}

describe("SyncEngine plugin apply seams (desiredActivePlugins / isManaged)", () => {
  let engine: SyncEngine | undefined;

  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  it("desiredActivePlugins INCLUDES an opted-in + enabled + non-suppressed + platform-allowed plugin", async () => {
    engine = makeEngine({ manifests: { dv: { isDesktopOnly: false } } });
    await engine.start();

    await engine.setPluginOptIn("dv", true);
    engine.setPluginEnabled("dv", true);

    expect(engine.desiredActivePlugins()).toEqual(["dv"]);
    expect(engine.isManaged("dv")).toBe(true);
  });

  it("desiredActivePlugins EXCLUDES not-opted-in, disabled, and 'zync'", async () => {
    engine = makeEngine({
      manifests: { dv: { isDesktopOnly: false }, tp: { isDesktopOnly: false } },
    });
    await engine.start();

    // dv: opted-in but DISABLED (enabled=false) → excluded.
    await engine.setPluginOptIn("dv", true);
    engine.setPluginEnabled("dv", false);

    // tp: shared-enabled but NOT opted-in on this device → excluded.
    engine.setPluginEnabled("tp", true);

    // zync: even if it somehow got an enabled entry, setPluginEnabled refuses it; assert absent.
    engine.setPluginEnabled("zync", true);

    expect(engine.desiredActivePlugins()).toEqual([]);
    // isManaged: dv (opted-in) is managed even though disabled; tp is not; zync never.
    expect(engine.isManaged("dv")).toBe(true);
    expect(engine.isManaged("tp")).toBe(false);
    expect(engine.isManaged("zync")).toBe(false);
  });

  it("desiredActivePlugins EXCLUDES a suppressed plugin, but isManaged stays TRUE (live-disable path)", async () => {
    engine = makeEngine({ manifests: { dv: { isDesktopOnly: false } } });
    await engine.start();

    await engine.setPluginOptIn("dv", true);
    engine.setPluginEnabled("dv", true);
    await engine.setPluginSuppressed("dv", true);

    // Suppressed → not desired-active (never ENABLED).
    expect(engine.desiredActivePlugins()).toEqual([]);
    // But STILL managed → the reconciler is allowed to live-disable it (D6). This is the fix.
    expect(engine.isManaged("dv")).toBe(true);
  });

  it("desiredActivePlugins EXCLUDES a desktop-only plugin on mobile, and isManaged is FALSE there", async () => {
    engine = makeEngine({ isMobile: true, manifests: { deskonly: { isDesktopOnly: true } } });
    await engine.start();

    await engine.setPluginOptIn("deskonly", true);
    engine.setPluginEnabled("deskonly", true);

    // Mobile + manifest.isDesktopOnly → platform-excluded → never active, not managed here.
    expect(engine.desiredActivePlugins()).toEqual([]);
    expect(engine.isManaged("deskonly")).toBe(false);
  });

  it("isManaged is FALSE for a local-only (not-opted-in) plugin — the never-touch-unmanaged guarantee", async () => {
    engine = makeEngine();
    await engine.start();

    // A plugin the user runs locally but never opted into Zync sync.
    expect(engine.isManaged("localonly")).toBe(false);
    expect(engine.desiredActivePlugins()).toEqual([]);
  });
});
