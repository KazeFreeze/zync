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

async function waitFor(cond: () => boolean | Promise<boolean>, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (await Promise.resolve(cond())) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitFor: condition not met within the tick budget");
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

  it("eager follower B materializes A's blob to disk in the background (decoupled from prose)", async () => {
    const blobStore = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", blobStore, "lazy");
    b = makeDevice(bus, "dev-b", blobStore, "eager");

    await a.engine.start();
    await b.engine.start();

    await a.vault.writeAtomic(IMG, PNG);
    await a.engine.waitConverged();
    await b.engine.waitConverged(); // prose converges WITHOUT waiting for the blob

    const sha = await sha256OfBytes(PNG);
    await waitFor(async () => {
      const d = await b.vault.read(IMG);
      return d !== null && (await sha256OfBytes(d)) === sha;
    });
    expect(await b.vault.read(IMG)).toEqual(PNG);

    // The background queue settles with the blob materialized, zero failures.
    await waitFor(() => b.engine.blobsSettled());
    expect(b.engine.blobProgress().failed).toBe(0);

    // Drain B's watcher fallout: materializing the blob fired an fs "create" that the M3 rename
    // coalescer buffered as a transient rename-target (a blob path is not in the prose index). The
    // live daemon's convergence loop / debounce timer drains it; here whenIdle force-drains it, and
    // the materialize echo-guard then suppresses the re-publish. (Pre-decouple this drained inside
    // waitConverged because the blob materialized within its loop; now it lands in the background.)
    await b.engine.whenIdle();

    // Blobs are no longer part of pendingDocs (the decouple): prose is converged.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("bootstrap publishes a blob already on disk -> eager follower materializes it in the background", async () => {
    const blobStore = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", blobStore, "lazy");
    b = makeDevice(bus, "dev-b", blobStore, "eager");

    await a.vault.writeAtomic(IMG, PNG);
    await a.engine.start();
    await b.engine.start();
    await a.engine.waitConverged();
    await b.engine.waitConverged();

    expect(b.engine.blobManifestEntries().length).toBe(1);
    await waitFor(async () => (await b.vault.read(IMG)) !== null);
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

    // The read-only manifest accessor still exposes the advertised entry (the blob-state surface).
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
    // observe → the background fetch queue enqueues → materialize → … spinning forever. Each spin
    // is one MORE writeAtomic for IMG, so the count is the loop detector. Pre-fix: hundreds/thousands.
    let bWritesForImg = 0;
    const realWrite = b.vault.writeAtomic.bind(b.vault);
    b.vault.writeAtomic = (p, data, opts): Promise<void> => {
      if (p === IMG) bWritesForImg++;
      return realWrite(p, data, opts);
    };

    await a.engine.start();
    await b.engine.start();
    await a.vault.writeAtomic(IMG, PNG);
    await a.engine.waitConverged();
    await b.engine.waitConverged();

    // The blob lands via the background queue (the SOLE eager writer now — drainEagerBlobs is gone).
    await waitFor(async () => (await b.vault.read(IMG)) !== null);
    // Let any spin run: the bounded queue dedups same-path, so a synced blob is written once.
    for (let i = 0; i < 50; i++) {
      await b.engine.whenIdle();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await b.vault.read(IMG)).toEqual(PNG);
    expect(bWritesForImg).toBeLessThanOrEqual(2);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });
});
