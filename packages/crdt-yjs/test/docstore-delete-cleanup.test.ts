import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, VaultPath } from "@zync/core";
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
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const identity = (id: string, name: string): IdentityPort => ({
  deviceId: () => id as DeviceId,
  deviceName: () => name,
});

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
  docStore: FakeDocStore;
}

function makeDevice(bus: InProcessBus, deviceId: string, blobs: FakeBlobStore): Device {
  const vault = new FakeVault();
  const docStore = new FakeDocStore();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs,
    docStore,
    clock: new FakeClock(),
    identity: identity(deviceId, `name-${deviceId}`),
    engineState: new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault, docStore };
}

describe("docStore snapshot cleanup on delete (no orphaned IDB snapshots)", () => {
  let a: Device;

  afterEach(async () => {
    await a.engine.stop();
  });

  it("removes the docStore snapshot when a note is deleted locally", async () => {
    const blobs = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", blobs);
    await a.engine.start();

    // Create a note locally -> ingest -> a docStore snapshot is persisted for its docId.
    const NOTE = path("note.md");
    await a.vault.writeAtomic(NOTE, utf8("# Note\n\nbody\n"));
    await a.engine.waitConverged();
    const afterCreate = await a.docStore.list();
    expect(afterCreate.length).toBeGreaterThan(0); // the note's snapshot exists

    // Delete the note -> onDelete tombstones it. Its CRDT snapshot must NOT be left orphaned.
    await a.vault.remove(NOTE);
    await a.engine.waitConverged();
    const afterDelete = await a.docStore.list();

    expect(afterDelete).toEqual([]); // the snapshot was cleaned up, not orphaned
  });

  it("removes a follower's docStore snapshot when an inbound tombstone deletes the note", async () => {
    const blobs = new FakeBlobStore();
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", blobs);
    const b = makeDevice(bus, "dev-b", blobs);
    const converge = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) {
        await a.engine.waitConverged();
        await b.engine.waitConverged();
        if (
          (await a.engine.pendingDocs()).length === 0 &&
          (await b.engine.pendingDocs()).length === 0
        )
          return;
      }
      throw new Error("did not converge");
    };
    try {
      await a.engine.start();
      await b.engine.start();

      // A creates a note; B (eager follower) materializes it -> B persists a docStore snapshot.
      const NOTE = path("note.md");
      await a.vault.writeAtomic(NOTE, utf8("# Shared\n\nbody\n"));
      await converge();
      expect((await b.docStore.list()).length).toBeGreaterThan(0); // B has the snapshot

      // A deletes the note -> the tombstone replicates to B via the INDEX -> B's structural
      // reconcile removes the file + base. B's CRDT snapshot must not be left orphaned either.
      await a.vault.remove(NOTE);
      await converge();

      expect(await b.docStore.list()).toEqual([]); // B's snapshot cleaned on inbound tombstone
    } finally {
      await b.engine.stop();
    }
  });
});
