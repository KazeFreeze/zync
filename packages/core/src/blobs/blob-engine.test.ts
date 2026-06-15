import { describe, it, expect } from "vitest";
import type { DeviceId, IdentityPort, VaultPath } from "../ports.js";
import { sha256OfBytes } from "../hash.js";
import { EchoLedger } from "../bridge/echo.js";
import { CorruptBlobError } from "../errors.js";
import { FakeVault } from "../testing/fake-vault.js";
import { FakeBlobStore } from "../testing/fake-blob-store.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { BlobEngine, type BlobFetchPolicy, type BlobManifestEntry } from "./blob-engine.js";

const path = (s: string): VaultPath => s as VaultPath;
const DEV_A = "dev-a" as DeviceId;

const identity = (deviceId: DeviceId): IdentityPort => ({
  deviceId: () => deviceId,
  deviceName: () => `name-${deviceId}`,
});

interface Harness {
  engine: BlobEngine;
  manifest: FakeCrdtMap<BlobManifestEntry>;
  blobStore: FakeBlobStore;
  vault: FakeVault;
  echo: EchoLedger;
}

function makeEngine(policy: BlobFetchPolicy, device: DeviceId = DEV_A): Harness {
  const manifest = new FakeCrdtMap<BlobManifestEntry>();
  const blobStore = new FakeBlobStore();
  const vault = new FakeVault();
  const echo = new EchoLedger();
  const engine = new BlobEngine({
    manifest,
    blobStore,
    vault,
    echo,
    identity: identity(device),
    policy,
  });
  return { engine, manifest, blobStore, vault, echo };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * `start()` drives a fire-and-forget async `materialize`; await the side effect
 * deterministically rather than guessing a tick count. Yields to the MACROTASK
 * queue each iteration because `materialize` awaits `crypto.subtle.digest`, which
 * resolves on a macrotask (microtask flushes alone never advance it).
 */
async function waitFor(cond: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("BlobEngine.onLocalBlobWrite (content-address → manifest + store)", () => {
  it("hashes, stores the bytes, and publishes the manifest entry", async () => {
    const h = makeEngine("eager");
    await h.engine.onLocalBlobWrite(path("img.png"), PNG);

    const sha = await sha256OfBytes(PNG);
    const entry = h.manifest.get("img.png");
    expect(entry).toEqual({ sha256: sha, size: PNG.length, deviceId: DEV_A });
    expect(await h.blobStore.has(sha)).toBe(true);
    expect(await h.blobStore.get(sha)).toEqual(PNG);
  });

  it("keep-old-versions: a new write under a new sha does NOT delete the old blob", async () => {
    const h = makeEngine("eager");
    const v1 = new Uint8Array([1, 1, 1]);
    const v2 = new Uint8Array([2, 2, 2, 2]);

    await h.engine.onLocalBlobWrite(path("img.png"), v1);
    const sha1 = await sha256OfBytes(v1);

    await h.engine.onLocalBlobWrite(path("img.png"), v2);
    const sha2 = await sha256OfBytes(v2);

    // Manifest now points at v2, but v1's bytes remain fetchable (no GC in 0b-2).
    expect(h.manifest.get("img.png")?.sha256).toBe(sha2);
    expect(await h.blobStore.has(sha1)).toBe(true);
    expect(await h.blobStore.has(sha2)).toBe(true);
  });
});

describe("BlobEngine.onManifestChange (eager vs lazy)", () => {
  it("eager: fetches bytes, hash-verifies, writes the vault (echo-recorded first)", async () => {
    const h = makeEngine("eager");
    const sha = await sha256OfBytes(PNG);
    await h.blobStore.put(sha, PNG);
    // The manifest entry arrives as if from a remote replica.
    h.manifest.set("img.png", { sha256: sha, size: PNG.length, deviceId: DEV_A });

    await h.engine.onManifestChange(path("img.png"));

    expect(await h.vault.read(path("img.png"))).toEqual(PNG);
    // The write was echo-recorded so the resulting fs event is recognized as ours.
    expect(h.echo.isEcho("img.png", sha)).toBe(true);
  });

  it("lazy: manifest-only — the vault is NOT written until materialize() is called", async () => {
    const h = makeEngine("lazy");
    const sha = await sha256OfBytes(PNG);
    await h.blobStore.put(sha, PNG);
    h.manifest.set("img.png", { sha256: sha, size: PNG.length, deviceId: DEV_A });

    await h.engine.onManifestChange(path("img.png"));
    // Still manifest-only: nothing materialized.
    expect(await h.vault.read(path("img.png"))).toBeNull();

    // On read/open, materialize fetches and writes the bytes.
    const bytes = await h.engine.materialize(path("img.png"));
    expect(bytes).toEqual(PNG);
    expect(await h.vault.read(path("img.png"))).toEqual(PNG);
  });
});

describe("BlobEngine.materialize (hash-verify-on-read)", () => {
  it("rejects a CORRUPT blob and does NOT write the vault", async () => {
    const h = makeEngine("lazy");
    const sha = await sha256OfBytes(PNG);
    const wrongBytes = new Uint8Array([9, 9, 9, 9]);
    // Store bytes that do NOT hash to `sha` (test-only escape hatch).
    h.blobStore.putRaw(sha, wrongBytes);
    h.manifest.set("img.png", { sha256: sha, size: PNG.length, deviceId: DEV_A });

    await expect(h.engine.materialize(path("img.png"))).rejects.toBeInstanceOf(CorruptBlobError);

    // The vault was left untouched — corrupt bytes never reached disk.
    expect(await h.vault.read(path("img.png"))).toBeNull();
    // And the corrupt sha was NOT echo-recorded (no write was attempted).
    expect(h.echo.isEcho("img.png", sha)).toBe(false);
  });

  it("carries expected vs actual on the CorruptBlobError", async () => {
    const h = makeEngine("lazy");
    const sha = await sha256OfBytes(PNG);
    const wrongBytes = new Uint8Array([9, 9, 9, 9]);
    h.blobStore.putRaw(sha, wrongBytes);
    h.manifest.set("img.png", { sha256: sha, size: PNG.length, deviceId: DEV_A });

    const actual = await sha256OfBytes(wrongBytes);
    await expect(h.engine.materialize(path("img.png"))).rejects.toMatchObject({
      path: "img.png",
      expected: sha,
      actual,
    });
  });

  it("throws when there is no manifest entry for the path", async () => {
    const h = makeEngine("eager");
    await expect(h.engine.materialize(path("missing.png"))).rejects.toThrow(/no manifest entry/);
  });

  it("echo-record IMMEDIATELY precedes writeAtomic in the materialize path", async () => {
    const h = makeEngine("lazy");
    const sha = await sha256OfBytes(PNG);
    await h.blobStore.put(sha, PNG);
    h.manifest.set("img.png", { sha256: sha, size: PNG.length, deviceId: DEV_A });

    // Record the ordering of (echo-record, vault-write) events.
    const order: string[] = [];
    const realRecord = h.echo.recordWrite.bind(h.echo);
    h.echo.recordWrite = (p: string, hash: string): void => {
      order.push(`echo:${p}:${hash}`);
      realRecord(p, hash);
    };
    h.vault.onEvent((e) => {
      order.push(`write:${e.path}`);
    });

    await h.engine.materialize(path("img.png"));

    expect(order).toEqual([`echo:img.png:${sha}`, "write:img.png"]);
  });
});

describe("BlobEngine two-device materialization (shared manifest + shared store)", () => {
  /**
   * Reproduces Fix 3's root bug at the engine level: device A writes a blob
   * (store + manifest), device B with `policy:"eager"` MUST materialize the bytes
   * onto its own vault when it observes the shared manifest entry. A SHARED
   * FakeCrdtMap + SHARED FakeBlobStore mimic the replicated index `blobs` map and
   * the content-addressed store both devices reach. Pre-fix the headless follower
   * defaulted to `"lazy"` (a NO-OP `onManifestChange`), so the blob never landed.
   */
  it("eager B materializes A's blob from the shared manifest+store", async () => {
    const manifest = new FakeCrdtMap<BlobManifestEntry>();
    const blobStore = new FakeBlobStore();

    // Device A: writes the blob locally (store the bytes + advertise the manifest entry).
    const vaultA = new FakeVault();
    const engineA = new BlobEngine({
      manifest,
      blobStore,
      vault: vaultA,
      echo: new EchoLedger(),
      identity: identity(DEV_A),
      policy: "lazy",
    });

    // Device B: EAGER + observing — it must auto-fetch the moment the entry lands.
    const vaultB = new FakeVault();
    const DEV_B = "dev-b" as DeviceId;
    const engineB = new BlobEngine({
      manifest,
      blobStore,
      vault: vaultB,
      echo: new EchoLedger(),
      identity: identity(DEV_B),
      policy: "eager",
    });

    let writtenB = false;
    vaultB.onEvent(() => {
      writtenB = true;
    });
    const unsubB = engineB.start();

    await engineA.onLocalBlobWrite(path("img.png"), PNG);
    // The shared FakeCrdtMap fires B's observe synchronously; its async materialize settles over ticks.
    await waitFor(() => writtenB);

    // B's vault now holds the byte-identical blob (the bug: pre-fix it stayed null).
    expect(await vaultB.read(path("img.png"))).toEqual(PNG);
    const sha = await sha256OfBytes(PNG);
    expect(await sha256OfBytes((await vaultB.read(path("img.png"))) ?? new Uint8Array())).toBe(sha);

    unsubB();
  });

  it("manifestEntries exposes the manifest read-only (for pendingDocs blob accounting)", async () => {
    const h = makeEngine("eager");
    await h.engine.onLocalBlobWrite(path("img.png"), PNG);
    const sha = await sha256OfBytes(PNG);
    expect(h.engine.manifestEntries()).toEqual([
      ["img.png", { sha256: sha, size: PNG.length, deviceId: DEV_A }],
    ]);
  });
});

describe("BlobEngine.start (observe → drive eager fetches)", () => {
  it("eager engine auto-materializes when a manifest entry is observed", async () => {
    const h = makeEngine("eager");
    const sha = await sha256OfBytes(PNG);
    await h.blobStore.put(sha, PNG);

    let written = false;
    h.vault.onEvent(() => {
      written = true;
    });

    const unsub = h.engine.start();
    h.manifest.set("img.png", { sha256: sha, size: PNG.length, deviceId: DEV_A });

    // The observe callback fires synchronously; the async fetch resolves over ticks.
    await waitFor(() => written);

    expect(written).toBe(true);
    expect(await h.vault.read(path("img.png"))).toEqual(PNG);
    unsub();
  });

  it("lazy engine stays manifest-only when observing (no auto-materialize)", async () => {
    const h = makeEngine("lazy");
    const sha = await sha256OfBytes(PNG);
    await h.blobStore.put(sha, PNG);

    let written = false;
    h.vault.onEvent(() => {
      written = true;
    });

    const unsub = h.engine.start();
    h.manifest.set("img.png", { sha256: sha, size: PNG.length, deviceId: DEV_A });

    // Give any (incorrect) eager fetch ample macrotask ticks to land — it must not.
    await waitFor(() => false, 5);

    expect(written).toBe(false);
    expect(await h.vault.read(path("img.png"))).toBeNull();
    unsub();
  });
});
