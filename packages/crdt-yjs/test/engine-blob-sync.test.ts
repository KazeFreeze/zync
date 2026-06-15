import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig, sha256OfBytes } from "@zync/core";
import type { BlobFetchPolicy, DeviceId, IdentityPort, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const IMG = path("art.png");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
}

/**
 * One device. `blobs` is a SHARED FakeBlobStore (passed in) so both engines reach the
 * same content-addressed store, exactly like the real server blob endpoint. The index
 * `blobs` manifest map replicates over the shared InProcessBus (it lives on the index doc).
 */
function makeDevice(
  bus: InProcessBus,
  deviceId: string,
  blobStore: FakeBlobStore,
  blobPolicy: BlobFetchPolicy,
): Device {
  const vault = new FakeVault();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs: blobStore,
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(deviceId, `name-${deviceId}`),
    engineState: new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
    blobPolicy,
  };
  return { engine: new SyncEngine(ports, config), vault };
}

describe("SyncEngine blob sync — eager follower materializes + blob-pending accounting", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("eager follower B materializes A's blob to disk; pendingDocs reports it until then", async () => {
    const blobStore = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", blobStore, "lazy");
    b = makeDevice(bus, "dev-b", blobStore, "eager"); // the headless follower default

    await a.engine.start();
    await b.engine.start();

    // A writes a binary blob after start (the live-harness path): store + manifest advertise.
    await a.vault.writeAtomic(IMG, PNG);
    await a.engine.waitConverged();

    // B (eager) must materialize the bytes onto its OWN disk. waitConverged loops until the
    // blob-pending accounting clears — pre-fix B reported pendingDocs===0 with NO file (the bug).
    await b.engine.waitConverged();

    const onDiskB = await b.vault.read(IMG);
    expect(onDiskB).toEqual(PNG);
    const sha = await sha256OfBytes(PNG);
    expect(await sha256OfBytes(onDiskB ?? new Uint8Array())).toBe(sha);

    // Both engines are quiescent (no false-quiescence: the blob is genuinely on B's disk).
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("bootstrap publishes a blob already on disk → eager follower materializes it", async () => {
    const blobStore = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", blobStore, "lazy");
    b = makeDevice(bus, "dev-b", blobStore, "eager");

    // A has the blob on disk BEFORE start (the fixture-load path) — bootstrap must publish it.
    await a.vault.writeAtomic(IMG, PNG);
    await a.engine.start();
    await b.engine.start();
    await a.engine.waitConverged();
    await b.engine.waitConverged();

    // A advertised the pre-existing blob; eager B fetched + materialized it.
    expect(b.engine.blobManifestEntries().length).toBe(1);
    expect(await b.vault.read(IMG)).toEqual(PNG);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("a LAZY follower's advertised-but-absent blob is NOT pending (deferred = converged)", async () => {
    const blobStore = new FakeBlobStore();
    const bus = new InProcessBus();
    // B is LAZY: it learns the manifest entry and intentionally never auto-materializes until
    // access. An un-materialized advertised blob under lazy policy is NOT pending — the device
    // HAS the manifest and will fetch on read, so it IS converged (CRITICAL 2). If pendingDocs
    // counted it, a lazy follower's waitConverged would hang forever.
    a = makeDevice(bus, "dev-a", blobStore, "lazy");
    b = makeDevice(bus, "dev-b", blobStore, "lazy");

    await a.engine.start();
    await b.engine.start();

    await a.vault.writeAtomic(IMG, PNG);
    await a.engine.waitConverged();

    // Drain B's reconciles so the manifest entry has replicated, but the blob bytes have NOT
    // been written to B's vault (lazy policy = manifest-only).
    await b.engine.whenIdle();

    expect(await b.vault.read(IMG)).toBeNull(); // bytes not materialized (lazy)
    // Lazy follower: the un-materialized advertised blob is NOT pending → it converges.
    expect(await b.engine.pendingDocs()).toEqual([]);
    // And a full waitConverged settles rather than hanging/throwing.
    await b.engine.waitConverged();

    // The read-only manifest accessor still exposes the advertised entry (used by pendingDocs).
    const sha = await sha256OfBytes(PNG);
    const entries = b.engine.blobManifestEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe(IMG);
    expect(entries[0]?.[1].sha256).toBe(sha);
    expect(entries[0]?.[1].size).toBe(PNG.length);
  });

  it("eager materialize of a synced blob does NOT spin (bounded vault writes — loop regression gate)", async () => {
    const blobStore = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", blobStore, "lazy");
    b = makeDevice(bus, "dev-b", blobStore, "eager"); // the headless follower default

    // Count EVERY writeAtomic the eager follower B performs for the blob path. The unbounded
    // feedback loop is: materialize → echo.recordWrite + vault.writeAtomic → fs "modify" →
    // onVaultEvent → onWrite (blob branch) → onLocalBlobWrite → manifest.set (re-stamp) →
    // observe → onManifestChange → materialize → … spinning forever. Each spin is one MORE
    // writeAtomic for IMG, so the count is the loop detector. Pre-fix: hundreds/thousands.
    let bWritesForImg = 0;
    const realWrite = b.vault.writeAtomic.bind(b.vault);
    b.vault.writeAtomic = (p, data, opts): Promise<void> => {
      if (p === IMG) bWritesForImg++;
      return realWrite(p, data, opts);
    };

    await a.engine.start();
    await b.engine.start();

    // A writes the blob after start: store + manifest advertise. B (eager) materializes it.
    await a.vault.writeAtomic(IMG, PNG);
    await a.engine.waitConverged();
    await b.engine.waitConverged();

    // Let any background spin run: drain inflight, then give the fire-and-forget materialize/
    // onWrite echo cycle ample macrotask ticks to spin if it is going to. A live daemon never
    // stops, so the untracked `void onManifestChange(...)` background work must self-terminate.
    for (let i = 0; i < 50; i++) {
      await b.engine.whenIdle();
      await new Promise((r) => setTimeout(r, 0));
    }

    // The blob landed on B's disk exactly once (idempotent) — NOT re-written on every echo.
    expect(await b.vault.read(IMG)).toEqual(PNG);
    // BOUNDED: a single synced blob ⇒ at most one materialize write on B. The loop is gone.
    expect(bWritesForImg).toBeLessThanOrEqual(2);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });
});
