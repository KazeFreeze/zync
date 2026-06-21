import { describe, it, expect } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { BlobStorePort, Sha256, DeviceId, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

/** Blob store that simulates the backing object store (S3/MinIO) being DOWN — every call 500s. */
class DownBlobStore implements BlobStorePort {
  has(sha: Sha256): Promise<boolean> {
    return Promise.reject(new Error(`blob store 500 (down): has ${String(sha)}`));
  }
  put(sha: Sha256, data: Uint8Array): Promise<void> {
    return Promise.reject(
      new Error(`blob store 500 (down): put ${String(sha)} (${String(data.length)}B)`),
    );
  }
  get(sha: Sha256): Promise<Uint8Array> {
    return Promise.reject(new Error(`blob store 500 (down): get ${String(sha)}`));
  }
}

describe("engine.start() resilience — a transient blob-store outage must not abort start", () => {
  it("starts despite a 500 from the blob store on a blob present at bootstrap", async () => {
    const vault = new FakeVault();
    // A binary blob already on disk when the engine starts → bootstrap tries to PUBLISH it
    // (content-address + blobStore.has/put). With the store down, has/put reject.
    await vault.writeAtomic(path("art.png"), PNG);
    const ports: EnginePorts = {
      vault,
      crdt: new YjsCrdtProvider(),
      transport: new InProcessBus().connect(),
      blobs: new DownBlobStore(),
      docStore: new FakeDocStore(),
      clock: new FakeClock(),
      identity: { deviceId: () => "dev-a" as DeviceId, deviceName: () => "A" },
      engineState: new MemEngineState(),
    };
    const config: EngineConfig = {
      configDir: ".obsidian",
      maxProseBytes: 1_000_000,
      substrate: "yjs",
      stampDebounceMs: 0,
      blobPolicy: "lazy",
    };
    const engine = new SyncEngine(ports, config);

    // The bug: the blob 500 propagates out of bootstrap → start() REJECTS → engine dead.
    // It must instead RESOLVE — the prose engine comes up regardless of a transient blob outage.
    await expect(engine.start()).resolves.toBeUndefined();

    await engine.stop();
  });
});
