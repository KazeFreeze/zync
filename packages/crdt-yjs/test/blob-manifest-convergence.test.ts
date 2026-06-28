import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { BlobEngine, EchoLedger, sha256OfBytes } from "@zync/core";
import type {
  BlobFetchPolicy,
  BlobManifestEntry,
  DeviceId,
  IdentityPort,
  VaultPath,
} from "@zync/core";
import { FakeVault, FakeBlobStore, FakeClock } from "@zync/core/testing";
import { YjsCrdtMap } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;

const identity = (deviceId: string): IdentityPort => ({
  deviceId: () => deviceId as DeviceId,
  deviceName: () => `name-${deviceId}`,
});

/** Sync `from` → `to` by exchanging the underlying yDoc update (manifest replication). */
function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

interface Replica {
  doc: Y.Doc;
  engine: BlobEngine;
  vault: FakeVault;
}

/** Two BlobEngines over two REAL YjsCrdtMaps (manifest) sharing ONE blob store (S3/R2). */
function makeReplica(device: string, policy: BlobFetchPolicy, blobStore: FakeBlobStore): Replica {
  const doc = new Y.Doc();
  const manifest = new YjsCrdtMap<BlobManifestEntry>(doc.getMap<BlobManifestEntry>("blobs"));
  const vault = new FakeVault();
  const engine = new BlobEngine({
    manifest,
    blobStore,
    vault,
    echo: new EchoLedger(),
    identity: identity(device),
    policy,
    clock: new FakeClock(),
    concurrency: 4,
    maxInFlightBytes: 1_000_000_000,
    maxRetries: 4,
    retryTickMs: 1_000_000_000, // heal tick effectively off for deterministic tests
    onBlobFailure: () => undefined,
  });
  return { doc, engine, vault };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 2, 0, 1, 5]);

/**
 * Await a fire-and-forget eager materialize deterministically. Yields to the
 * MACROTASK queue each iteration because `materialize` awaits `crypto.subtle.digest`
 * (resolves on a macrotask; microtask flushes alone never advance it).
 */
async function waitFor(cond: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("Blob manifest convergence over real YjsCrdtMap (shared blob store)", () => {
  it("manifest replicates; eager B auto-materializes the byte-identical blob, hash-verified", async () => {
    // ONE blob store shared by both devices (simulating S3/R2).
    const blobStore = new FakeBlobStore();
    const a = makeReplica("dev-a", "lazy", blobStore);
    const b = makeReplica("dev-b", "eager", blobStore);

    // B is eager and observing: it auto-fetches the moment the manifest entry lands.
    let writtenB = false;
    b.vault.onEvent(() => {
      writtenB = true;
    });
    const unsubB = b.engine.start();

    // A writes a binary blob locally: content-address + store + publish manifest entry.
    await a.engine.onLocalBlobWrite(path("img.png"), PNG);

    // Replicate the manifest map A → B (Y.encodeStateAsUpdate / applyUpdate).
    sync(a.doc, b.doc);

    // The observe callback drives an async materialize; let it settle.
    await waitFor(() => writtenB);

    // B's vault now holds the byte-identical blob (hash-verified on the way in).
    const onDiskB = await b.vault.read(path("img.png"));
    expect(onDiskB).toEqual(PNG);
    // Its hash matches the manifest sha — proof the bytes were verified, not corrupted.
    const sha = await sha256OfBytes(PNG);
    expect(await sha256OfBytes(onDiskB ?? new Uint8Array())).toBe(sha);

    unsubB();
    a.doc.destroy();
    b.doc.destroy();
  });

  it("a LAZY B does NOT write the vault on manifest replication (until materialize)", async () => {
    const blobStore = new FakeBlobStore();
    const a = makeReplica("dev-a", "lazy", blobStore);
    const b = makeReplica("dev-b", "lazy", blobStore);

    const unsubB = b.engine.start();

    let writtenB = false;
    b.vault.onEvent(() => {
      writtenB = true;
    });

    await a.engine.onLocalBlobWrite(path("img.png"), PNG);
    sync(a.doc, b.doc);
    // Give any (incorrect) eager fetch ample macrotask ticks to land — it must not.
    await waitFor(() => false, 5);
    expect(writtenB).toBe(false);

    // Lazy B stays manifest-only: the blob is NOT on B's disk yet.
    expect(await b.vault.read(path("img.png"))).toBeNull();

    // On read/open, B materializes the byte-identical blob from the shared store.
    const sha = await sha256OfBytes(PNG);
    expect(await b.engine.materialize(path("img.png"), sha)).toBe("written");
    expect(await b.vault.read(path("img.png"))).toEqual(PNG);

    unsubB();
    a.doc.destroy();
    b.doc.destroy();
  });
});
