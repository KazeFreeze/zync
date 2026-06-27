import { describe, it, expect, afterEach } from "vitest";
import {
  SyncEngine,
  type EnginePorts,
  type EngineConfig,
  type DeviceId,
  type IdentityPort,
  type VaultEvent,
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
const decode = (u: Uint8Array | null): string =>
  u === null ? "<absent>" : new TextDecoder().decode(u);
const CONFIG = ".obsidian";

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}
interface Durable {
  vault: FakeVault;
  docStore: FakeDocStore;
  engineState: MemEngineState;
  blobs: FakeBlobStore;
}
function newDurable(durable: boolean): Durable {
  return {
    vault: new FakeVault({ durable }),
    docStore: new FakeDocStore(),
    engineState: new MemEngineState(),
    blobs: new FakeBlobStore(),
  };
}

interface Device {
  engine: SyncEngine;
  transport: InProcessTransport;
}
function makeEngine(
  bus: InProcessBus,
  d: Durable,
  deviceId: string,
  extra?: Partial<EngineConfig>,
): Device {
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault: d.vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: d.blobs,
    docStore: d.docStore,
    clock: new FakeClock(),
    identity: identity(deviceId),
    engineState: d.engineState,
  };
  const config: EngineConfig = {
    configDir: CONFIG,
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
    ...extra,
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

// Move a file on DISK without firing the engine's subscribed rename listener — simulates the raw
// external `mv` that the live watcher only ever observes as a delete(old) + modify(new) pair.
// (FakeVault.rename emits a synthetic "rename" event that would short-circuit onRename; relocate the
// bytes via the test-only seam so the engine sees ONLY the manual emit() events the test drives.)
async function moveOnDiskSilently(d: Durable, from: VaultPath, to: VaultPath): Promise<void> {
  const bytes = await d.vault.read(from);
  if (bytes === null) throw new Error(`moveOnDiskSilently: ${from} absent`);
  d.vault.relocateSilently(from, to);
}

// Drive the engine's vault-event handler directly (simulates the watcher) and wait out the rename window.
function emit(dev: Device, e: VaultEvent): void {
  // FakeVault exposes the same onEvent listeners the engine subscribes to; emit via its test seam.
  (dev.engine as unknown as { onVaultEventForTest(e: VaultEvent): void }).onVaultEventForTest(e);
}
async function settleRename(dev: Device): Promise<void> {
  // whenIdle() force-drains the buffer (Task 4) — no need to wait out the debounce window.
  await dev.engine.whenIdle();
}

// A FakeVault whose BASE-record reads can be delayed, to model a slow `base.load` over a real adapter
// (FUSE/cloud/contended disk). Used by the Part B pending-phase test: the barrier must hold via
// pendingSourcePaths while the source's base.load is still in flight.
class SlowBaseVault extends FakeVault {
  baseReadDelayMs = 0;
  override async read(path: VaultPath): Promise<Uint8Array | null> {
    if (this.baseReadDelayMs > 0 && path.includes("/zync/base/")) {
      await new Promise((r) => setTimeout(r, this.baseReadDelayMs));
    }
    return super.read(path);
  }
}

describe("Part A — external folder mv via dir-delete expansion", () => {
  it("a raw `mv notes archive` re-keys EVERY child with docId continuity", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const children = ["a.md", "b.md", "c.md"] as const;
    for (const c of children)
      await durA.vault.writeAtomic(p(`notes/${c}`), utf8(`unique body ${c}`));
    await durA.vault.writeAtomic(p("keep.md"), utf8("sibling control"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    const before = new Map<string, string>();
    for (const c of children) {
      const id = a.engine.index.get(p(`notes/${c}`))?.docId;
      if (id === undefined) throw new Error(`no docId for notes/${c}`);
      before.set(c, id);
    }

    for (const c of children) await moveOnDiskSilently(durA, p(`notes/${c}`), p(`archive/${c}`));
    emit(a, { type: "delete", path: p("notes") });
    for (const c of children) emit(a, { type: "modify", path: p(`archive/${c}`) });
    await settleRename(a);
    await converge(a, b);

    for (const c of children) {
      const id = before.get(c);
      expect(a.engine.index.get(p(`archive/${c}`))?.docId).toBe(id);
      expect(a.engine.index.get(p(`notes/${c}`))?.deleted).toBe(true);
      expect(decode(await durB.vault.read(p(`archive/${c}`)))).toBe(`unique body ${c}`);
    }
    expect(a.engine.index.get(p("keep.md"))?.deleted).not.toBe(true);
    expect((await a.engine.pendingDocs()).length).toBe(0);
  });

  it("genuine `rm -rf notes` (per-child deletes + dir delete) tombstones all, idempotently", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    for (const c of ["a.md", "b.md"])
      await durA.vault.writeAtomic(p(`notes/${c}`), utf8(`body ${c}`));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    for (const c of ["a.md", "b.md"])
      durA.vault.relocateSilently(p(`notes/${c}`), p(`.trash/${c}`));
    emit(a, { type: "delete", path: p("notes/a.md") });
    emit(a, { type: "delete", path: p("notes/b.md") });
    emit(a, { type: "delete", path: p("notes") });
    await settleRename(a);
    await converge(a, b);
    expect(a.engine.index.get(p("notes/a.md"))?.deleted).toBe(true);
    expect(a.engine.index.get(p("notes/b.md"))?.deleted).toBe(true);
    expect((await a.engine.pendingDocs()).length).toBe(0);
  });

  it("nested `mv notes archive` expands deep children; sibling prefix `notes-backup` untouched", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    await durA.vault.writeAtomic(p("notes/sub/d.md"), utf8("deep body delta"));
    await durA.vault.writeAtomic(p("notes-backup/x.md"), utf8("backup body x"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const deep = a.engine.index.get(p("notes/sub/d.md"))?.docId;
    const backup = a.engine.index.get(p("notes-backup/x.md"))?.docId;
    await moveOnDiskSilently(durA, p("notes/sub/d.md"), p("archive/sub/d.md"));
    emit(a, { type: "delete", path: p("notes") });
    emit(a, { type: "modify", path: p("archive/sub/d.md") });
    await settleRename(a);
    await converge(a, b);
    expect(a.engine.index.get(p("archive/sub/d.md"))?.docId).toBe(deep);
    expect(a.engine.index.get(p("notes/sub/d.md"))?.deleted).toBe(true); // source side of the re-key
    expect(a.engine.index.get(p("notes-backup/x.md"))?.docId).toBe(backup);
    expect(a.engine.index.get(p("notes-backup/x.md"))?.deleted).not.toBe(true);
  });

  it("`delete <dir>` with NO live children is a harmless no-op", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    emit(a, { type: "delete", path: p("emptydir") });
    await settleRename(a);
    expect((await a.engine.pendingDocs()).length).toBe(0);
  });
});

describe("Part C — requestRename directory guard", () => {
  it("refuses a directory rename (live children) and surfaces a conflict notice", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    await durA.vault.writeAtomic(p("notes/a.md"), utf8("body a"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.whenIdle();
    const ok = await a.engine.requestRename(p("notes"), p("archive"));
    expect(ok).toBe(false); // refused: `notes` is a folder
    expect(a.engine.index.get(p("notes/a.md"))?.deleted).not.toBe(true); // child untouched
  });
});

describe("Part B — missing-live materialize barrier", () => {
  it("a concurrent full pass does NOT re-materialize a moved-away source mid-rename (clause 1)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    await durA.vault.writeAtomic(p("notes/a.md"), utf8("unique body for clause-1"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const id = a.engine.index.get(p("notes/a.md"))?.docId;

    await moveOnDiskSilently(durA, p("notes/a.md"), p("archive/a.md"));
    emit(a, { type: "delete", path: p("notes/a.md") }); // buffered as a rename SOURCE
    emit(a, { type: "modify", path: p("archive/a.md") }); // target
    await a.engine.runFullConvergencePass(); // CONCURRENT pass while the source is buffered
    expect(await durA.vault.read(p("notes/a.md"))).toBeNull(); // barrier held — source not rewritten

    await settleRename(a);
    await converge(a, b);
    expect(a.engine.index.get(p("archive/a.md"))?.docId).toBe(id); // continuity preserved
    expect(await durA.vault.read(p("notes/a.md"))).toBeNull();
  });

  it("clause 1 holds while the source's base.load is still in flight (pendingSourcePaths)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    durA.vault = new SlowBaseVault({ durable: true });
    await durA.vault.writeAtomic(p("notes/a.md"), utf8("slow-base unique body"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const id = a.engine.index.get(p("notes/a.md"))?.docId;
    (durA.vault as SlowBaseVault).baseReadDelayMs = 60;
    await moveOnDiskSilently(durA, p("notes/a.md"), p("archive/a.md"));
    emit(a, { type: "delete", path: p("notes/a.md") });
    await a.engine.runFullConvergencePass(); // fires WHILE base.load is in flight
    expect(await durA.vault.read(p("notes/a.md"))).toBeNull(); // pendingSourcePaths held the barrier
    (durA.vault as SlowBaseVault).baseReadDelayMs = 0;
    emit(a, { type: "modify", path: p("archive/a.md") });
    await settleRename(a);
    await converge(a, b);
    expect(a.engine.index.get(p("archive/a.md"))?.docId).toBe(id); // continuity through the slow-base path
  });
});
