/**
 * Plugin-data first-sync: silent-adopt + loser-bytes backup + reload-on-resolve.
 *
 * Design: docs/superpowers/specs/2026-07-11-zync-plugin-data-first-sync-adopt-design.md
 *
 * CHANGE 1 (onConfigDivergence): a plugin-data file with NO recorded config base is a first
 * cross-device convergence (independently-created data.json, no common ancestor). Accept the
 * remote silently (return false, no inbox entry) instead of raising a false conflict on both
 * devices — BUT first snapshot the about-to-be-clobbered local bytes to a device-local
 * `_conflicts/` backup (Fable recoverability). Scope guard: plugin-data ONLY; themes/snippets/
 * plugins with a null base still raise a conflict.
 *
 * CHANGE 2 (firePluginDataReload): the reload hook (`pluginDataMatCbs`) now fires from BOTH
 * the materialize path AND resolveConfigConflict keep-theirs, so a hookless plugin (no
 * onExternalSettingsChange) is reloaded after its data.json changes on conflict-resolve.
 *
 * Tests drive onConfigDivergence directly via the private-method seam (mirrors
 * config-conflict.test.ts) and resolveConfigConflict via the public method.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig, sha256OfBytes } from "@zync/core";
import type {
  ConfigPort,
  DeviceId,
  IdentityPort,
  Sha256,
  Unsubscribe,
  VaultPath,
} from "@zync/core";
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

// A plugin-data path: configCategoryOf → "plugin-data", pluginIdOf → "cal".
const PLUGIN_DATA_PATH = vp(".obsidian/plugins/cal/data.json");
// A NON-plugin-data path (snippets) for the scope-guard test.
const SNIPPET_PATH = vp(".obsidian/snippets/my.css");

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

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

// Structural subtype for the private config CRDT map + private onConfigDivergence.
interface EngineInternals {
  indexDoc: null | {
    getMap(name: string): {
      get(key: string): { sha256: string; size: number; dataVersion?: number } | undefined;
      set(
        key: string,
        value: {
          sha256: string;
          size: number;
          category: string;
          deviceId: string;
          dataVersion?: number;
        },
      ): void;
    };
  };
  onConfigDivergence: (
    p: VaultPath,
    i: { localSha: Sha256; expectedSha: Sha256 },
  ) => Promise<boolean>;
  reconcileConfigDrift: () => Promise<void>;
}

interface Setup {
  engine: SyncEngine;
  blobStore: FakeBlobStore;
  vault: FakeVault;
  configPort: ReturnType<typeof makeConfigPort>;
  engineState: MemEngineState;
}

function makeSetup(): Setup {
  const bus = new InProcessBus();
  const blobStore = new FakeBlobStore();
  const configPort = makeConfigPort();
  const engineState = new MemEngineState();
  const vault = new FakeVault();

  const ports: EnginePorts = {
    vault,
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
    configCategories: { themes: true, snippets: true, plugins: true, "plugin-data": true },
  };
  return { engine: new SyncEngine(ports, config), blobStore, vault, configPort, engineState };
}

const asInternals = (e: SyncEngine): EngineInternals => e as unknown as EngineInternals;

/**
 * Two DISTINCT canonical-JSON plugin-data payloads ordered by canonical sha, so a test can
 * deterministically drive the null-base TIE-BREAK: the LOWER-sha value loses (adopts remote), the
 * HIGHER-sha value wins (asserted into the config map, kept on disk). Inputs are already canonical
 * (single sorted key, no whitespace) so `sha256OfBytes` equals the engine's canonical sha.
 */
async function shaOrdered(): Promise<{
  low: Uint8Array;
  lowSha: Sha256;
  high: Uint8Array;
  highSha: Sha256;
}> {
  const a1 = enc('{"pick":"alpha"}');
  const a2 = enc('{"pick":"bravo"}');
  const s1 = await sha256OfBytes(a1);
  const s2 = await sha256OfBytes(a2);
  return s1 < s2
    ? { low: a1, lowSha: s1, high: a2, highSha: s2 }
    : { low: a2, lowSha: s2, high: a1, highSha: s1 };
}

/** Poll until `cond` is truthy, or throw after `maxTicks` microtask turns. */
async function waitFor(cond: () => boolean, maxTicks = 300): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitFor: condition not met within tick budget");
}

// ── Version-aware plugin-data convergence (LEAN) ───────────────────────────────
// Design: docs/superpowers/specs/2026-07-11-zync-plugin-data-version-tiebreak-design.md
// Ordering is by a per-edit numeric version (recency) first, canonical-sha only for true
// (equal-version) ties, and ONLY the equal-version loser is backed up.

/** Seed a config-map plugin-data entry at a given canonical sha + numeric version. */
function setMapEntry(
  engine: SyncEngine,
  path: VaultPath,
  sha256: Sha256,
  size: number,
  version: number,
  deviceId = "remote-dev",
): void {
  asInternals(engine)
    .indexDoc?.getMap("config")
    .set(path, {
      sha256,
      size,
      category: "plugin-data",
      deviceId,
      ...(version > 0 ? { dataVersion: version } : {}),
    });
}

const configFileCount = (engine: SyncEngine): number =>
  engine.inbox.list().filter((e) => e.kind === "config-file").length;

describe("onConfigDivergence — plugin-data version-aware convergence", () => {
  let engine: SyncEngine | undefined;
  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  it("(1) sequential edit (remoteVersion>localVersion) → false, NO inbox, NO backup — the on-device regression", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // Shared base at v1 on both. The peer authored v2 (a newer edit). This device holds its
    // still-agreed v1 value on disk (localSha === base) BUT we exercise the diverged read path by
    // giving the disk a DIFFERENT (lower-sha) value at version 1, so the recency rule (not the
    // clean fast-forward) must adopt the remote without a revert.
    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(highSha, high); // remote v2 value
    setup.configPort.files.set(PLUGIN_DATA_PATH, low); // local dirty at v1
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 1);
    // The config map holds the remote's newer v2 value. localSha (low) > expectedSha would make
    // hash-only tie-break pick LOCAL; version recency must override and adopt remote anyway.
    setMapEntry(engine, PLUGIN_DATA_PATH, highSha, high.length, 2);

    const before = configFileCount(engine);
    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: lowSha,
      expectedSha: highSha,
    });

    expect(result).toBe(false); // adopt the newer remote (recency)
    expect(configFileCount(engine)).toBe(before); // NO inbox
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0); // NO backup (lean)
  });

  it("(1b) sequential edit where local sha > remote sha still adopts remote when remoteVersion>localVersion (recency beats hash)", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(lowSha, low); // remote value (lower sha) but NEWER version
    setup.configPort.files.set(PLUGIN_DATA_PATH, high); // local value (higher sha) but OLDER version
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 1);
    setMapEntry(engine, PLUGIN_DATA_PATH, lowSha, low.length, 2);

    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: highSha,
      expectedSha: lowSha,
    });

    expect(result).toBe(false); // remoteVersion(2) > localVersion(1) → adopt, even though localSha > expectedSha
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0);
  });

  it("(2) equal version, REMOTE wins hash tie-break (localSha < expectedSha) → false + backup, NO inbox", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // local = LOWER-sha value (loses the tie-break), remote = HIGHER-sha value (wins). Equal version.
    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(highSha, high);
    setup.configPort.files.set(PLUGIN_DATA_PATH, low);
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 1);
    setMapEntry(engine, PLUGIN_DATA_PATH, highSha, high.length, 1); // same version → true tie

    const before = configFileCount(engine);
    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: lowSha,
      expectedSha: highSha,
    });

    expect(result).toBe(false); // remote (higher sha) wins → accept-remote, let it materialize
    expect(configFileCount(engine)).toBe(before); // NO inbox entry
    // The loser's pre-adopt bytes are backed up under _conflicts/ (recoverable).
    const backups = await setup.vault.list(vp("_conflicts/"));
    expect(backups.length).toBe(1);
    const backupBytes = await setup.vault.read(backups[0]?.path ?? vp(""));
    expect(new TextDecoder().decode(backupBytes ?? new Uint8Array())).toBe(
      new TextDecoder().decode(low),
    );
  });

  it("(3) equal version, LOCAL wins hash tie-break (localSha > expectedSha) → true, asserts map+base, NO backup/inbox", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // local = HIGHER-sha value (wins), remote = LOWER-sha value (loses). Equal version.
    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(lowSha, low);
    setup.configPort.files.set(PLUGIN_DATA_PATH, high);
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 1);
    setMapEntry(engine, PLUGIN_DATA_PATH, lowSha, low.length, 1); // same version → true tie

    const before = configFileCount(engine);
    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: highSha,
      expectedSha: lowSha,
    });

    expect(result).toBe(true); // local (higher sha) wins → keep local, skip materialize
    expect(configFileCount(engine)).toBe(before); // NO inbox
    // The map now ASSERTS local (higher) at the local version so the PEER's reconcile re-fires.
    const asserted = asInternals(engine).indexDoc?.getMap("config").get(PLUGIN_DATA_PATH);
    expect(asserted?.sha256).toBe(highSha);
    expect(asserted?.dataVersion).toBe(1); // entry keeps the local version
    // Base recorded = local; local bytes present in the blob store for the peer to fetch.
    expect(await setup.engineState.getConfigBase(PLUGIN_DATA_PATH)).toBe(highSha);
    expect(await setup.blobStore.has(highSha)).toBe(true);
    // NO backup — local is KEPT, nothing was clobbered.
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0);
  });

  it("(4) local newer (remoteVersion<localVersion) → assert local, true, NO backup", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(lowSha, low); // remote value, OLDER version
    setup.configPort.files.set(PLUGIN_DATA_PATH, high); // local value, NEWER version
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 3);
    setMapEntry(engine, PLUGIN_DATA_PATH, lowSha, low.length, 2); // remote older

    const before = configFileCount(engine);
    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: highSha,
      expectedSha: lowSha,
    });

    expect(result).toBe(true); // assert local authority
    expect(configFileCount(engine)).toBe(before); // NO inbox
    const asserted = asInternals(engine).indexDoc?.getMap("config").get(PLUGIN_DATA_PATH);
    expect(asserted?.sha256).toBe(highSha);
    expect(asserted?.dataVersion).toBe(3); // asserts at the LOCAL version
    expect(await setup.engineState.getConfigBase(PLUGIN_DATA_PATH)).toBe(highSha);
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0); // NO backup — local kept
  });

  it("(5) clean fast-forward (localSha === base, remote newer) → false, no backup", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(highSha, high); // remote newer value
    // Disk unchanged since last agreed: localSha === base.
    setup.configPort.files.set(PLUGIN_DATA_PATH, low);
    await setup.engineState.setConfigBase(PLUGIN_DATA_PATH, lowSha);
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 1);
    setMapEntry(engine, PLUGIN_DATA_PATH, highSha, high.length, 2);

    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: lowSha, // === base
      expectedSha: highSha,
    });

    expect(result).toBe(false); // adopt remote, disk had nothing local to lose
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0);
  });

  it("(6) versionless-remote guard: remoteVersion=0, localVersion>0, divergent → hash tie-break (NOT auto-adopt-local)", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // local (higher sha) at version 2; remote entry has NO version (=> 0). Fable's mixed-fleet guard
    // treats this as concurrent (a tie), so the loser is decided by hash, not by version — and here
    // local wins the hash (higher sha) so it asserts. The point: it is NOT silently auto-adopting
    // local by "localVersion(2) > remoteVersion(0)"; a LOWER-sha local would LOSE + back up.
    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(lowSha, low); // remote value, versionless
    setup.configPort.files.set(PLUGIN_DATA_PATH, high);
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 2);
    setMapEntry(engine, PLUGIN_DATA_PATH, lowSha, low.length, 0); // version 0 (absent)

    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: highSha,
      expectedSha: lowSha,
    });

    // Treated as a tie → hash tie-break → local (higher sha) wins → assert (true), NO backup.
    expect(result).toBe(true);
    const asserted = asInternals(engine).indexDoc?.getMap("config").get(PLUGIN_DATA_PATH);
    expect(asserted?.sha256).toBe(highSha);
    expect(asserted?.dataVersion).toBe(2);
  });

  it("(6b) versionless-remote guard: remote higher-sha wins the tie → backup, false (loser recoverable)", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // local LOWER sha at version 2, remote HIGHER sha versionless. Guard => concurrent tie =>
    // remote (higher sha) wins => local backed up (NOT silently kept by version).
    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(highSha, high);
    setup.configPort.files.set(PLUGIN_DATA_PATH, low);
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 2);
    setMapEntry(engine, PLUGIN_DATA_PATH, highSha, high.length, 0);

    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: lowSha,
      expectedSha: highSha,
    });

    expect(result).toBe(false); // remote wins tie → adopt
    const backups = await setup.vault.list(vp("_conflicts/"));
    expect(backups.length).toBe(1); // loser backed up
  });

  it("(8) scope guard: null-base NON-plugin-data (snippets) divergent → returns true (conflict raised)", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    const localBytes = enc("/* local snippet */");
    const remoteBytes = enc("/* remote snippet */");
    const localSha = await sha256OfBytes(localBytes);
    const remoteSha = await sha256OfBytes(remoteBytes);
    await setup.blobStore.put(remoteSha, remoteBytes);
    setup.configPort.files.set(SNIPPET_PATH, localBytes);
    // NO base recorded → but snippets must still raise a conflict.

    const result = await asInternals(engine).onConfigDivergence(SNIPPET_PATH, {
      localSha,
      expectedSha: remoteSha,
    });

    expect(result).toBe(true); // conflict raised — version-aware convergence is plugin-data ONLY
    const entry = engine.inbox
      .list()
      .find((e) => e.kind === "config-file" && e.path === SNIPPET_PATH);
    expect(entry).toBeDefined();
  });

  it("(8b) canonical no-op: local canonically-EQUAL to remote → false, NO backup", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // Same JSON value, different key order / whitespace → canonically EQUAL.
    const localBytes = enc('{ "b": 2, "a": 1 }');
    const remoteCanonical = enc('{"a":1,"b":2}');
    const localSha = await sha256OfBytes(localBytes);
    const remoteSha = await sha256OfBytes(remoteCanonical);
    await setup.blobStore.put(remoteSha, remoteCanonical);
    setup.configPort.files.set(PLUGIN_DATA_PATH, localBytes);
    // Even at divergent versions, canonical-equal short-circuits FIRST.
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 5);
    setMapEntry(engine, PLUGIN_DATA_PATH, remoteSha, remoteCanonical.length, 1);

    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha,
      expectedSha: remoteSha,
    });

    expect(result).toBe(false);
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0); // no clobber → no litter
  });

  it("(8c) no local file → returns false, no backup", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    const remoteBytes = enc('{"fresh":true}');
    const remoteSha = await sha256OfBytes(remoteBytes);
    await setup.blobStore.put(remoteSha, remoteBytes);
    setMapEntry(engine, PLUGIN_DATA_PATH, remoteSha, remoteBytes.length, 2);
    // No local file on disk → nothing to preserve.

    const result = await asInternals(engine).onConfigDivergence(PLUGIN_DATA_PATH, {
      localSha: remoteSha,
      expectedSha: remoteSha,
    });

    expect(result).toBe(false);
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0);
  });
});

// ── CHANGE 2: reload hook on conflict-resolve ──────────────────────────────────

describe("firePluginDataReload / resolveConfigConflict reload (CHANGE 2)", () => {
  let engine: SyncEngine | undefined;
  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  it("(6) keep-theirs on a plugin-data conflict for a desired-active plugin → reload cb fires with the id", async () => {
    const setup = makeSetup();
    const eng = setup.engine;
    engine = eng;
    await eng.start();

    // Make "cal" desired-active: opt-in + enabled + local manifest present.
    setup.configPort.files.set(
      ".obsidian/plugins/cal/manifest.json",
      enc(JSON.stringify({ id: "cal", name: "Calendar", version: "1.0.0" })),
    );
    await eng.setPluginOptIn("cal", true);
    eng.setPluginEnabled("cal", true);
    await waitFor(() => eng.desiredActivePlugins().includes("cal"));

    const theirBytes = enc('{"weekStart":"sun"}');
    const localBytes = enc('{"weekStart":"mon"}');
    const localSha = await sha256OfBytes(localBytes);
    const remoteSha = await sha256OfBytes(theirBytes);
    await setup.blobStore.put(remoteSha, theirBytes);
    setup.configPort.files.set(PLUGIN_DATA_PATH, localBytes);
    // Publish the remote entry to the config map (the state onConfigDivergence leaves).
    asInternals(eng).indexDoc?.getMap("config").set(PLUGIN_DATA_PATH, {
      sha256: remoteSha,
      size: theirBytes.length,
      category: "plugin-data",
      deviceId: "remote-dev",
    });

    // Register the reload hook (what main.ts subscribes for the reload chokepoint).
    const fired: string[] = [];
    eng.onPluginDataMaterialized((id) => fired.push(id));

    const id = `config-file:${PLUGIN_DATA_PATH}`;
    eng.inbox.add({
      id,
      kind: "config-file",
      path: PLUGIN_DATA_PATH,
      localSha,
      remoteSha,
      localSize: localBytes.length,
      remoteSize: theirBytes.length,
      detail: "Config file changed on another device.",
    });

    await eng.resolveConfigConflict(id, "keep-theirs");

    expect(fired).toContain("cal"); // reload delivered even without a live hook
  });

  it("(7) firePluginDataReload: non-desired-active plugin → cb does NOT fire", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // "cal" is NEITHER opted-in nor enabled → NOT desired-active.
    expect(engine.desiredActivePlugins()).not.toContain("cal");

    const theirBytes = enc('{"weekStart":"sun"}');
    const localBytes = enc('{"weekStart":"mon"}');
    const localSha = await sha256OfBytes(localBytes);
    const remoteSha = await sha256OfBytes(theirBytes);
    await setup.blobStore.put(remoteSha, theirBytes);
    setup.configPort.files.set(PLUGIN_DATA_PATH, localBytes);
    asInternals(engine).indexDoc?.getMap("config").set(PLUGIN_DATA_PATH, {
      sha256: remoteSha,
      size: theirBytes.length,
      category: "plugin-data",
      deviceId: "remote-dev",
    });

    const fired: string[] = [];
    engine.onPluginDataMaterialized((id) => fired.push(id));

    const id = `config-file:${PLUGIN_DATA_PATH}`;
    engine.inbox.add({
      id,
      kind: "config-file",
      path: PLUGIN_DATA_PATH,
      localSha,
      remoteSha,
      localSize: localBytes.length,
      remoteSize: theirBytes.length,
      detail: "Config file changed on another device.",
    });

    await engine.resolveConfigConflict(id, "keep-theirs");

    expect(fired).not.toContain("cal"); // not desired-active → no reload
    expect(fired.length).toBe(0);
  });
});

// ── CONFIG RECONCILE BACKSTOP: reconcileConfigDrift ────────────────────────────
// The observe-only drift hole: config materialize re-checks a path's disk ONLY when its CRDT map
// entry mutates. During a reconnect race a device adopts a TRANSIENT map value, then the map SETTLES
// to a different value with NO further observe for that device → disk≠settled-map forever (a stable
// split-brain). reconcileConfigDrift re-scans disk-vs-map INDEPENDENT of observe and force-resolves
// any drift via the SAME materialize seam the observe path uses. These tests construct the stuck
// state directly (map at one value, disk at another) and drive the backstop.

describe("reconcileConfigDrift — config reconcile backstop for observe-only drift", () => {
  let engine: SyncEngine | undefined;
  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  // The backstop drives blobEngine.materialize, which applies the RoutedManifest gate: a plugin-data
  // path only materializes when its plugin is opted-in, code-installed, and version-unblocked — the
  // NORMAL condition in the harness reconnect scenario. Make "cal" opted-in with a local manifest and
  // wait for the version gate to release the data path so the seam is exercised realistically.
  async function activateCal(setup: Setup, eng: SyncEngine): Promise<void> {
    setup.configPort.files.set(
      ".obsidian/plugins/cal/manifest.json",
      enc(JSON.stringify({ id: "cal", name: "Calendar", version: "1.0.0" })),
    );
    await eng.setPluginOptIn("cal", true);
    eng.setPluginEnabled("cal", true);
    await waitFor(() => eng.desiredActivePlugins().includes("cal"));
  }
  // The version gate holds a data path pessimistically on every config-map change; wait until it
  // RELEASES (RoutedManifest exposes the entry again ⇒ manifestEntries lists it) before reconciling.
  async function waitGateReleased(eng: SyncEngine): Promise<void> {
    await waitFor(() => eng.blobManifestEntries().some(([p]) => p === PLUGIN_DATA_PATH));
  }

  it("(a) disk≠map, remote NEWER (recency) → disk materializes to the map value", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();
    await activateCal(setup, engine);

    // STUCK STATE: the config map SETTLED to the remote's NEWER (v2) value; this device is stuck
    // holding an OLDER (v1) value on disk with NO observe left to re-drive it. The remote value's
    // bytes are present in the blob store (published), so accept-remote can materialize them.
    const { low, high, highSha } = await shaOrdered();
    await setup.blobStore.put(highSha, high); // remote v2 value bytes available to fetch
    setup.configPort.files.set(PLUGIN_DATA_PATH, low); // disk stuck at the old v1 value
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 1);
    setMapEntry(engine, PLUGIN_DATA_PATH, highSha, high.length, 2); // settled map = newer remote
    await waitGateReleased(engine);

    // Pre-condition: disk (low) ≠ map (high) — the split-brain.
    expect(
      new TextDecoder().decode(setup.configPort.files.get(PLUGIN_DATA_PATH) ?? new Uint8Array()),
    ).toBe(new TextDecoder().decode(low));

    await asInternals(engine).reconcileConfigDrift();

    // Drift resolved: recency adopts the newer remote → disk now equals the settled map value.
    expect(
      new TextDecoder().decode(setup.configPort.files.get(PLUGIN_DATA_PATH) ?? new Uint8Array()),
    ).toBe(new TextDecoder().decode(high));
    // localVersion adopted the remote edit-version (materialize's onMaterialized records it).
    expect(await setup.engineState.getConfigLocalVersion(PLUGIN_DATA_PATH)).toBe(2);
    // No inbox raised; no clobber-backup on a sequential (non-tie) adopt.
    expect(configFileCount(engine)).toBe(0);
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0);
  });

  it("(b) disk≠map, LOCAL should win (local newer) → map gets local asserted (disk kept)", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();
    await activateCal(setup, engine);

    // STUCK STATE: this device holds its NEWER (v3) value on disk, but the config map SETTLED to a
    // peer's OLDER (v2) value (a transient the observe missed). reconcileConfigDrift must ASSERT the
    // local value back into the map so the peer re-converges — disk is authoritative and kept.
    const { low, lowSha, high, highSha } = await shaOrdered();
    await setup.blobStore.put(lowSha, low); // stale remote value in the map
    setup.configPort.files.set(PLUGIN_DATA_PATH, high); // disk = local NEWER value
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 3);
    setMapEntry(engine, PLUGIN_DATA_PATH, lowSha, low.length, 2); // settled map = older remote
    await waitGateReleased(engine);

    await asInternals(engine).reconcileConfigDrift();

    // Local asserted into the map at the local version; disk unchanged (kept), map now agrees.
    const asserted = asInternals(engine).indexDoc?.getMap("config").get(PLUGIN_DATA_PATH);
    expect(asserted?.sha256).toBe(highSha);
    expect(asserted?.dataVersion).toBe(3);
    expect(await setup.engineState.getConfigBase(PLUGIN_DATA_PATH)).toBe(highSha);
    expect(
      new TextDecoder().decode(setup.configPort.files.get(PLUGIN_DATA_PATH) ?? new Uint8Array()),
    ).toBe(new TextDecoder().decode(high)); // disk kept
    expect(configFileCount(engine)).toBe(0);
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0); // local kept → no backup
  });

  it("(c) disk === map → no-op (no write, no inbox, no assert)", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // No drift: disk canonically equals the config-map entry. The backstop must not touch anything.
    const value = enc('{"pick":"alpha"}');
    const valueSha = await sha256OfBytes(value);
    await setup.blobStore.put(valueSha, value);
    setup.configPort.files.set(PLUGIN_DATA_PATH, value);
    await setup.engineState.setConfigLocalVersion(PLUGIN_DATA_PATH, 2);
    setMapEntry(engine, PLUGIN_DATA_PATH, valueSha, value.length, 2);
    // Record a base so a wrongful re-drive would be observable; a true no-op leaves it untouched.
    await setup.engineState.setConfigBase(PLUGIN_DATA_PATH, valueSha);

    const mapBefore = asInternals(engine).indexDoc?.getMap("config").get(PLUGIN_DATA_PATH);
    const versionBefore = await setup.engineState.getConfigLocalVersion(PLUGIN_DATA_PATH);

    await asInternals(engine).reconcileConfigDrift();

    // Everything unchanged: map entry identical, disk identical, no inbox, no backup.
    const mapAfter = asInternals(engine).indexDoc?.getMap("config").get(PLUGIN_DATA_PATH);
    expect(mapAfter?.sha256).toBe(mapBefore?.sha256);
    expect(mapAfter?.dataVersion).toBe(mapBefore?.dataVersion);
    expect(await setup.engineState.getConfigLocalVersion(PLUGIN_DATA_PATH)).toBe(versionBefore);
    expect(
      new TextDecoder().decode(setup.configPort.files.get(PLUGIN_DATA_PATH) ?? new Uint8Array()),
    ).toBe(new TextDecoder().decode(value));
    expect(configFileCount(engine)).toBe(0);
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0);
  });

  it("(d) missing local file → skipped (that is the normal fetch path, not drift)", async () => {
    const setup = makeSetup();
    engine = setup.engine;
    await engine.start();

    // A config-map entry with NO local file on disk = the not-yet-fetched path; the fetch queue owns
    // it. reconcileConfigDrift must SKIP it (never fight the fetch) — no write, no inbox, no throw.
    const remote = enc('{"pick":"bravo"}');
    const remoteSha = await sha256OfBytes(remote);
    await setup.blobStore.put(remoteSha, remote);
    setMapEntry(engine, PLUGIN_DATA_PATH, remoteSha, remote.length, 2);
    // No configPort.files entry for PLUGIN_DATA_PATH → read() returns null.

    await asInternals(engine).reconcileConfigDrift();

    // Untouched: the backstop did not materialize (that is the fetch queue's job), no litter.
    expect(setup.configPort.files.has(PLUGIN_DATA_PATH)).toBe(false);
    expect(configFileCount(engine)).toBe(0);
    expect((await setup.vault.list(vp("_conflicts/"))).length).toBe(0);
  });
});
