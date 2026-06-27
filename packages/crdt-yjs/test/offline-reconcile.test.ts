import { describe, it, expect, afterEach } from "vitest";
import {
  SyncEngine,
  type EnginePorts,
  type EngineConfig,
  type DeviceId,
  type IdentityPort,
  type VaultPath,
} from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
  type InProcessTransport,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const p = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array | null): string =>
  b === null ? "<absent>" : new TextDecoder().decode(b);
const CONFIG = ".obsidian";
const NOTE = p("notes/alpha.md");
const CONTENT = "STATUS: alpha\n\nA real note with substantial unique content.";

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}
interface Durable {
  vault: FakeVault;
  docStore: FakeDocStore;
  engineState: MemEngineState;
  blobs: FakeBlobStore;
}
function newDurable(): Durable {
  return {
    vault: new FakeVault(),
    docStore: new FakeDocStore(),
    engineState: new MemEngineState(),
    blobs: new FakeBlobStore(),
  };
}
interface Device {
  engine: SyncEngine;
  transport: InProcessTransport;
}
function makeEngine(bus: InProcessBus, durable: Durable, deviceId: string): Device {
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault: durable.vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: durable.blobs,
    docStore: durable.docStore,
    clock: new FakeClock(),
    identity: identity(deviceId),
    engineState: durable.engineState,
  };
  const config: EngineConfig = {
    configDir: CONFIG,
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), transport };
}
const open: SyncEngine[] = [];
afterEach(async () => {
  for (const e of open) await e.stop().catch(() => undefined);
  open.length = 0;
});
async function converge(...devs: Device[]): Promise<void> {
  for (let i = 0; i < 30; i++) {
    let pending = 0;
    for (const dvc of devs) {
      await dvc.engine.waitConverged();
      pending += (await dvc.engine.pendingDocs()).length;
    }
    if (pending === 0) return;
  }
}

describe("M1a offline reconciliation (cold restart over persisted stores)", () => {
  it("offline DELETE: a file removed while closed is MATERIALIZED back (no wedge, no tombstone)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable();
    const durB = newDurable();
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a1 = makeEngine(bus, durA, "device-a");
    const b1 = makeEngine(bus, durB, "device-b");
    open.push(a1.engine, b1.engine);
    await a1.engine.start();
    await b1.engine.start();
    await converge(a1, b1);

    await a1.engine.stop();
    open.length = 0;
    await durA.vault.remove(NOTE);

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b1.engine);
    await a2.engine.start();
    await converge(a2, b1);

    expect(decode(await durA.vault.read(NOTE))).toBe(CONTENT);
    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true);
    expect(decode(await durB.vault.read(NOTE))).toBe(CONTENT);
    expect((await a2.engine.pendingDocs()).length).toBe(0);
  });

  it("offline RENAME: a file moved while closed re-keys the docId (continuity), both converge", async () => {
    const bus = new InProcessBus();
    const durA = newDurable();
    const durB = newDurable();
    const RENAMED = p("notes/renamed.md");
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a1 = makeEngine(bus, durA, "device-a");
    const b1 = makeEngine(bus, durB, "device-b");
    open.push(a1.engine, b1.engine);
    await a1.engine.start();
    await b1.engine.start();
    await converge(a1, b1);
    const docIdBefore = a1.engine.index.get(NOTE)?.docId;

    await a1.engine.stop();
    open.length = 0;
    await durA.vault.remove(NOTE);
    await durA.vault.writeAtomic(RENAMED, utf8(CONTENT));

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b1.engine);
    await a2.engine.start();
    await converge(a2, b1);

    expect(a2.engine.index.get(RENAMED)?.docId).toBe(docIdBefore);
    expect(a2.engine.index.get(RENAMED)?.deleted).not.toBe(true);
    expect(a2.engine.index.get(NOTE)?.deleted).toBe(true);
    expect(decode(await durA.vault.read(RENAMED))).toBe(CONTENT);
    expect(decode(await durB.vault.read(RENAMED))).toBe(CONTENT);
    expect(decode(await durB.vault.read(NOTE))).toBe("<absent>");
  });

  it("false-rename trap: a copy of a STILL-LIVE file is NOT re-keyed onto a deleted note's docId", async () => {
    const bus = new InProcessBus();
    const durA = newDurable();
    const durB = newDurable();
    const TEMPLATE = p("notes/template.md");
    const COPY = p("notes/copy.md");
    const DUP = "shared identical body that template and the deleted note both hold";
    await durA.vault.writeAtomic(NOTE, utf8(DUP));
    await durA.vault.writeAtomic(TEMPLATE, utf8(DUP));
    const a1 = makeEngine(bus, durA, "device-a");
    const b1 = makeEngine(bus, durB, "device-b");
    open.push(a1.engine, b1.engine);
    await a1.engine.start();
    await b1.engine.start();
    await converge(a1, b1);
    const templateDocId = a1.engine.index.get(TEMPLATE)?.docId;
    const noteDocId = a1.engine.index.get(NOTE)?.docId;

    await a1.engine.stop();
    open.length = 0;
    await durA.vault.remove(NOTE);
    await durA.vault.writeAtomic(COPY, utf8(DUP));

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b1.engine);
    await a2.engine.start();
    await converge(a2, b1);

    expect(a2.engine.index.get(COPY)?.docId).not.toBe(noteDocId);
    expect(a2.engine.index.get(TEMPLATE)?.docId).toBe(templateDocId);
    expect(decode(await durA.vault.read(TEMPLATE))).toBe(DUP);
  });

  it("fresh ADOPT: a device with no local files + no bases materializes normally, no false action", async () => {
    const bus = new InProcessBus();
    const durA = newDurable();
    const durB = newDurable();
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a1 = makeEngine(bus, durA, "device-a");
    const b1 = makeEngine(bus, durB, "device-b");
    open.push(a1.engine, b1.engine);
    await a1.engine.start();
    await b1.engine.start();
    await converge(a1, b1);

    const durC = newDurable();
    const c1 = makeEngine(bus, durC, "device-c");
    open.push(c1.engine);
    await c1.engine.start();
    await converge(a1, b1, c1);

    expect(c1.engine.index.get(NOTE)?.deleted).not.toBe(true);
    expect(decode(await durC.vault.read(NOTE))).toBe(CONTENT);
  });

  // B2: materialize reads base.baseText, not the docStore snapshot — so a vanished synced file is recovered
  // from the LOCAL base even when its snapshot is ALSO gone (e.g. evicted). No wedge, no snapshot dependency.
  it("offline DELETE with the docStore snapshot ALSO gone: materialize from base recovers it (no wedge)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable();
    const durB = newDurable();
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a1 = makeEngine(bus, durA, "device-a");
    const b1 = makeEngine(bus, durB, "device-b");
    open.push(a1.engine, b1.engine);
    await a1.engine.start();
    await b1.engine.start();
    await converge(a1, b1);
    const docId = a1.engine.index.get(NOTE)?.docId;
    if (docId === undefined) throw new Error("expected a live docId for the note");

    // Closed: the file AND the docStore snapshot both vanish (snapshot evicted), base kept. With B2 the
    // pre-pass materializes base.baseText directly — no snapshot needed — so this no longer wedges.
    await a1.engine.stop();
    open.length = 0;
    await durA.vault.remove(NOTE);
    await durA.docStore.delete(docId);

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b1.engine);
    await a2.engine.start();
    await converge(a2, b1);

    expect(decode(await durA.vault.read(NOTE))).toBe(CONTENT); // recovered from base by the pre-pass materialize
    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true);
    expect((await a2.engine.pendingDocs()).length).toBe(0); // no wedge
  });
});
