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
// A FakeVault whose BASE-record reads can be delayed, to model a slow `base.load` over a real adapter
// (FUSE/cloud/contended disk). Used by the F1 regression test: a source delete's base.load must not be
// outrun by the debounce timer (which would drain a target without its matching source → a split rename).
class SlowBaseVault extends FakeVault {
  baseReadDelayMs = 0;
  override async read(path: VaultPath): Promise<Uint8Array | null> {
    if (this.baseReadDelayMs > 0 && path.includes("/zync/base/")) {
      await new Promise((r) => setTimeout(r, this.baseReadDelayMs));
    }
    return super.read(path);
  }
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

// Private-internals test seam: the coalescer buffer + its single-flight drain. Used by the liveness
// test to drive a "during-drain" refill WITHOUT relying on whenIdle to mask the stranding.
interface CoalescerInternals {
  renameBuf: {
    sources: Map<unknown, unknown>;
    targets: Set<unknown>;
    timer: ReturnType<typeof setTimeout> | null;
  };
  runRenameDrain(): Promise<void>;
  renameDrainDelay(now: number, firstArmedAt: number): number;
}
function internals(dev: Device): CoalescerInternals {
  return dev.engine as unknown as CoalescerInternals;
}
// Poll a predicate on the REAL event loop (real setTimeout, no whenIdle) up to `budgetMs`. Lets a
// re-armed debounce timer fire on its own, so the test observes liveness rather than forcing a drain.
async function pollUntil(predicate: () => boolean, budgetMs = 1000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("M3 live rename coalesce — core", () => {
  it("external mv (delete(old)+modify(new), content-matched) re-keys with docId continuity, no delete", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const OLD = p("notes/old.md");
    const NEW = p("notes/new.md");
    const BODY = "a unique substantial note body for the rename";
    await durA.vault.writeAtomic(OLD, utf8(BODY));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(OLD)?.docId;
    if (docId === undefined) throw new Error("expected a live docId");

    // Simulate the raw external `mv old new` the running watcher sees: delete(old) THEN modify(new).
    await moveOnDiskSilently(durA, OLD, NEW); // moves the file on disk WITHOUT firing the engine's rename path
    emit(a, { type: "delete", path: OLD });
    emit(a, { type: "modify", path: NEW });
    await settleRename(a);
    await converge(a, b);

    expect(a.engine.index.get(NEW)?.docId).toBe(docId); // SAME docId — continuity
    expect(a.engine.index.get(OLD)?.deleted).toBe(true); // old key tombstoned by the re-key (not a propagated delete)
    expect(decode(await durB.vault.read(NEW))).toBe(BODY); // peer has it at the new path
    expect(decode(await durB.vault.read(OLD))).toBe("<absent>");
    expect((await a.engine.pendingDocs()).length).toBe(0);
  });

  it("the REVERSE watcher ordering (modify(new) before delete(old)) also re-keys", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const OLD = p("notes/o.md");
    const NEW = p("notes/n.md");
    const BODY = "reverse-ordering unique body content";
    await durA.vault.writeAtomic(OLD, utf8(BODY));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(OLD)?.docId;
    await moveOnDiskSilently(durA, OLD, NEW);
    emit(a, { type: "modify", path: NEW }); // target first
    emit(a, { type: "delete", path: OLD });
    await settleRename(a);
    await converge(a, b);
    expect(a.engine.index.get(NEW)?.docId).toBe(docId);
  });

  it("a normal edit (modify of a bound-live path) is NOT buffered — ingests immediately", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const NOTE = p("notes/edit.md");
    await durA.vault.writeAtomic(NOTE, utf8("v1 unique body"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    await durA.vault.writeAtomic(NOTE, utf8("v2 unique body edited"));
    emit(a, { type: "modify", path: NOTE });
    await a.engine.whenIdle(); // no rename window needed for a bound-live edit
    await converge(a, b);
    expect(decode(await durB.vault.read(NOTE))).toBe("v2 unique body edited");
  });
});

describe("M3 live rename coalesce — unmatched routing", () => {
  it("a lone delete (no matching create) propagates as a genuine delete after the window", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const NOTE = p("notes/gone.md");
    await durA.vault.writeAtomic(NOTE, utf8("clean body to be deleted, unique"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b); // materializedHash observed (clean)
    await durA.vault.remove(NOTE);
    emit(a, { type: "delete", path: NOTE });
    await settleRename(a);
    await converge(a, b);
    expect(a.engine.index.get(NOTE)?.deleted).toBe(true);
    expect(decode(await durB.vault.read(NOTE))).toBe("<absent>"); // propagated
  });

  it("a lone create (no matching delete) ingests as a new file after the window", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const NEW = p("notes/fresh.md");
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    await durA.vault.writeAtomic(NEW, utf8("a brand new note, unique body"));
    emit(a, { type: "modify", path: NEW });
    await settleRename(a);
    await converge(a, b);
    expect(a.engine.index.get(NEW)?.deleted).not.toBe(true);
    expect(decode(await durB.vault.read(NEW))).toBe("a brand new note, unique body");
  });

  it("a DIRTY unmatched-lost doc materializes back (preserves the unpushed edit), not tombstoned", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const NOTE = p("notes/dirty.md");
    await durA.vault.writeAtomic(NOTE, utf8("original body unique"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(NOTE)?.docId;
    if (docId === undefined) throw new Error("docId");
    // Make the doc dirty with an unpushed edit advanced in base, then a genuine delete fires.
    const basePath = p(`.obsidian/zync/base/${docId}.json`);
    const NEW = "original body unique\n\nunpushed offline edit";
    const raw = await durA.vault.read(basePath);
    if (raw === null) throw new Error("base");
    const rec = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    const { sha256OfText } = await import("@zync/core");
    rec.baseText = NEW;
    rec.fileHash = await sha256OfText(NEW);
    await durA.vault.writeAtomic(basePath, utf8(JSON.stringify(rec)));
    await durA.engineState.markDirty(docId);
    await durA.vault.remove(NOTE);
    emit(a, { type: "delete", path: NOTE });
    await settleRename(a);
    await converge(a, b);
    expect(a.engine.index.get(NOTE)?.deleted).not.toBe(true); // NOT tombstoned
    expect(decode(await durA.vault.read(NOTE))).toBe(NEW); // materialized back, unpushed edit preserved
    expect((await a.engine.pendingDocs()).length).toBe(0);
  });
});

describe("M3 live rename coalesce — folder-move burst (hard cap)", () => {
  it("a burst of N renames drains as ONE batch and ALL re-key with docId continuity", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const N = 4;
    const files = Array.from({ length: N }, (_, i) => ({
      old: p(`folderA/file${String(i)}.md`),
      new: p(`folderB/file${String(i)}.md`),
      body: `burst rename body number ${String(i)}, unique and substantial enough to content-match`,
    }));
    for (const f of files) await durA.vault.writeAtomic(f.old, utf8(f.body));
    // Tiny window + cap so the whole burst drains as a single capped batch (no wall-clock flake).
    const a = makeEngine(bus, durA, "device-a", { renameWindowMs: 5, renameWindowCapMs: 10 });
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docIds = files.map((f) => {
      const id = a.engine.index.get(f.old)?.docId;
      if (id === undefined) throw new Error(`expected a live docId for ${f.old}`);
      return id;
    });

    // The folder move arrives as a BURST of delete(old)+modify(new) pairs (no native rename event).
    for (const f of files) await moveOnDiskSilently(durA, f.old, f.new);
    for (const f of files) {
      emit(a, { type: "delete", path: f.old });
      emit(a, { type: "modify", path: f.new });
    }
    await settleRename(a);
    await converge(a, b);

    for (const [i, f] of files.entries()) {
      expect(a.engine.index.get(f.new)?.docId).toBe(docIds[i]); // docId continuity per file
      expect(a.engine.index.get(f.old)?.deleted).toBe(true); // old key tombstoned by the re-key
      expect(decode(await durB.vault.read(f.new))).toBe(f.body); // peer has each at the new path
      expect(decode(await durB.vault.read(f.old))).toBe("<absent>");
    }
    expect((await a.engine.pendingDocs()).length).toBe(0);
    expect((await b.engine.pendingDocs()).length).toBe(0);
  });
});

describe("M3 live rename coalesce — remote-delete-during-window", () => {
  it("a remote delete during the window wins; the rename is abandoned, no resurrection", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const OLD = p("notes/raced.md");
    const NEW = p("notes/raced-new.md");
    const BODY = "content that exists on both before the race, unique";
    await durA.vault.writeAtomic(OLD, utf8(BODY));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const oldDocId = a.engine.index.get(OLD)?.docId;
    if (oldDocId === undefined) throw new Error("oldDocId");

    // A starts an external mv: buffer the source (delete) + target (modify), but DON'T drain yet.
    await moveOnDiskSilently(durA, OLD, NEW);
    emit(a, { type: "delete", path: OLD });
    emit(a, { type: "modify", path: NEW });
    // Meanwhile B deletes the SAME doc at OLD; drain ONLY B so its tombstone reaches A's index
    // (delivered synchronously by the bus) BEFORE A's window drains.
    await durB.vault.remove(OLD);
    emit(b, { type: "delete", path: OLD });
    await b.engine.whenIdle(); // B tombstones OLD's docId; the tombstone lands in A's index
    expect(a.engine.index.get(OLD)?.deleted).toBe(true); // A saw the remote tombstone pre-drain
    await settleRename(a); // now A drains — the re-validate guard must abandon the match
    await converge(a, b);

    // The remote delete wins: OLD's docId is NOT resurrected at NEW under the old docId.
    const newEntry = a.engine.index.get(NEW);
    expect(newEntry?.docId).not.toBe(oldDocId); // not a resurrection re-key
    // NEW still exists as a fresh ingest (content preserved), both devices converge identically.
    expect(decode(await durA.vault.read(NEW))).toBe(BODY);
    expect((await a.engine.pendingDocs()).length).toBe(0);
    expect((await b.engine.pendingDocs()).length).toBe(0);
  });
});

describe("M3 live rename coalesce — quiescence + requestRename", () => {
  it("whenIdle force-drains the buffer (no live-but-missing wedge, no race)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const OLD = p("notes/q-old.md");
    const NEW = p("notes/q-new.md");
    await durA.vault.writeAtomic(OLD, utf8("quiescence body unique"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(OLD)?.docId;
    await moveOnDiskSilently(durA, OLD, NEW);
    emit(a, { type: "delete", path: OLD });
    emit(a, { type: "modify", path: NEW });
    // Do NOT wait the window — call whenIdle directly. It must force-drain so the rename is applied.
    await a.engine.whenIdle();
    expect(a.engine.index.get(NEW)?.docId).toBe(docId); // drained synchronously by whenIdle
    expect(a.engine.index.get(OLD)?.deleted).toBe(true);
  });

  it("a buffered signal keeps pendingDocs non-empty until drained", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const NOTE = p("notes/pend.md");
    await durA.vault.writeAtomic(NOTE, utf8("pending body unique"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.whenIdle();
    await durA.vault.remove(NOTE);
    emit(a, { type: "delete", path: NOTE }); // buffered, timer not yet fired
    expect((await a.engine.pendingDocs()).length).toBeGreaterThan(0); // buffer counts as pending
  });

  it("requestRename refuses a target that is a buffered rename target", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const T = p("notes/buffered-target.md");
    const X = p("notes/x.md");
    await durA.vault.writeAtomic(X, utf8("x body unique"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.whenIdle();
    // T is physically present + buffered as an unbound rename target (not yet in the index).
    await durA.vault.writeAtomic(T, utf8("incoming external content unique"));
    emit(a, { type: "modify", path: T });
    const ok = await a.engine.requestRename(X, T);
    expect(ok).toBe(false); // refused — must not clobber the buffered target
  });
});

describe("M3 live rename coalesce — buffered-during-drain liveness", () => {
  // A rename SIGNAL that arrives WHILE a drain is in flight re-arms a debounce timer; when THAT timer
  // fires, runRenameDrain() sees `draining !== null`, returns the in-flight drain, and (pre-fix) does
  // not re-process or re-arm. The real setTimeout callback fired ONCE and does not null
  // `renameBuf.timer`, so the refilled buffer is left with a DEAD timer and no live one — stranded
  // until the next vault event or a whenIdle/waitConverged force-drain. In a live daemon between
  // convergence checks that can be delayed indefinitely. (Microtask-fast FakeVault drains cannot
  // keep a drain "in flight" across an async re-buffer, so we test the re-arm INVARIANT directly:
  // after a drain completes with a refilled buffer, a live timer MUST be armed.)
  it("runRenameDrain re-arms a live timer when the buffer refilled during the drain", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const OLD = p("notes/inv-old.md");
    const NEW = p("notes/inv-new.md");
    const LATE = p("notes/inv-late.md");
    const LATE_BODY = "a late unbound create buffered mid-drain, unique substantial body";
    await durA.vault.writeAtomic(OLD, utf8("invariant body, unique and substantial"));
    const a = makeEngine(bus, durA, "device-a", { renameWindowMs: 20, renameWindowCapMs: 1000 });
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // Buffer a rename pair, then start its drain MANUALLY (as the debounce timer would): the drain
    // snapshots+clears the buffer synchronously, then suspends on its first await (`draining` set).
    await moveOnDiskSilently(durA, OLD, NEW);
    emit(a, { type: "delete", path: OLD });
    emit(a, { type: "modify", path: NEW });
    await pollUntil(() => internals(a).renameBuf.sources.size >= 1); // async source landed
    const drain = internals(a).runRenameDrain();

    // Refill the buffer DURING the drain (a lone unbound create suffices), then model the re-armed
    // debounce timer having FIRED mid-drain: the real setTimeout callback fires once and does NOT
    // null `renameBuf.timer`, so absent a re-arm the refilled buffer keeps only a DEAD timer.
    await durA.vault.writeAtomic(LATE, utf8(LATE_BODY));
    emit(a, { type: "modify", path: LATE });
    const armed = internals(a).renameBuf.timer;
    if (armed !== null) clearTimeout(armed);
    internals(a).renameBuf.timer = null;
    await drain;

    // INVARIANT: a refilled buffer after a drain MUST have a LIVE timer re-armed (else it is
    // stranded — recovered only by the next vault event or a whenIdle/waitConverged force-drain).
    expect(
      internals(a).renameBuf.targets.size + internals(a).renameBuf.sources.size,
    ).toBeGreaterThan(0);
    expect(internals(a).renameBuf.timer).not.toBeNull();

    // LIVENESS: with the re-armed timer live, the late create coalesces WITHOUT whenIdle — poll the
    // index on the real event loop until the re-armed debounce fires and ingests it.
    const ingested = await pollUntil(() => {
      const e = a.engine.index.get(LATE);
      return e !== undefined && e.deleted !== true;
    });
    expect(ingested).toBe(true);
    await converge(a, b);
    expect(decode(await durB.vault.read(LATE))).toBe(LATE_BODY);
  });
});

describe("M3 live rename coalesce — slow base.load must not split the rename (F1)", () => {
  it("a debounce timer firing before a slow source base.load still re-keys (no fresh-docId split)", async () => {
    const bus = new InProcessBus();
    const vault = new SlowBaseVault({ durable: true });
    const durA: Durable = {
      vault,
      docStore: new FakeDocStore(),
      engineState: new MemEngineState(),
      blobs: new FakeBlobStore(),
    };
    const durB = newDurable(true);
    const OLD = p("notes/slow-old.md");
    const NEW = p("notes/slow-new.md");
    const BODY = "slow base load rename body, unique and substantial enough to content-match";
    await durA.vault.writeAtomic(OLD, utf8(BODY));
    // Tiny window so the timer fires WELL before the (slow) source base.load resolves.
    const a = makeEngine(bus, durA, "device-a", { renameWindowMs: 10, renameWindowCapMs: 1000 });
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(OLD)?.docId;
    if (docId === undefined) throw new Error("expected a live docId");

    // From now on, every base-record read stalls 80ms — far longer than the 10ms debounce window.
    vault.baseReadDelayMs = 80;
    await moveOnDiskSilently(durA, OLD, NEW);
    emit(a, { type: "delete", path: OLD }); // bufferRenameSource awaits the SLOW base.load
    emit(a, { type: "modify", path: NEW }); // arms the 10ms timer — which fires before the load lands
    // Drive ONLY the real event loop (no whenIdle, which would drain inflight first and mask the bug):
    // the timer-driven drain must wait for the in-flight source buffer before snapshotting.
    const ok = await pollUntil(() => a.engine.index.get(NEW)?.docId === docId, 2000);
    expect(ok).toBe(true); // SAME docId — the rename re-keyed; it was NOT split into a fresh-docId ingest
    expect(a.engine.index.get(OLD)?.deleted).toBe(true);
    vault.baseReadDelayMs = 0;
    await converge(a, b);
    expect(decode(await durB.vault.read(NEW))).toBe(BODY);
  });
});

describe("M3 live rename coalesce — target re-bound during the window (F3)", () => {
  it("a match does NOT clobber a target re-bound to a different live docId (mirror bootstrap guard)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const OLD = p("notes/f3-old.md");
    const TARGET = p("notes/f3-target.md");
    const OCC = p("notes/f3-occupant.md");
    const BODY_A = "the moved source content, unique and substantial enough to content-match";
    const BODY_R = "a DIFFERENT occupant doc that gets renamed onto the target, unique body";
    await durA.vault.writeAtomic(OLD, utf8(BODY_A));
    await durA.vault.writeAtomic(OCC, utf8(BODY_R));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docIdA = a.engine.index.get(OLD)?.docId;
    const docIdR = a.engine.index.get(OCC)?.docId;
    if (docIdA === undefined || docIdR === undefined) throw new Error("docIds");

    // A's external mv OLD -> TARGET: buffer the source (delete) + target (modify) while TARGET is unbound.
    await moveOnDiskSilently(durA, OLD, TARGET);
    emit(a, { type: "delete", path: OLD });
    emit(a, { type: "modify", path: TARGET });
    // DURING the window, a remote rename binds docId R onto TARGET (model the inbound index state).
    a.engine.index.rename(OCC, TARGET);
    expect(a.engine.index.get(TARGET)?.docId).toBe(docIdR); // TARGET now live for R
    // Drive exactly ONE drain (the F1 pendingSources await lands the source first). We assert the GUARD's
    // guarantee directly — not full convergence: the buffered-target disk bytes (A's moved content) now
    // diverge from R's binding, and resolving THAT divergence is the deferred runtime path-collision
    // recovery (M2 runtime twin), not F3. F3 only refuses to CLOBBER R.
    await internals(a).runRenameDrain();

    // THE GUARD: the drain must NOT re-key A into TARGET (that would clobber R's live binding). R survives.
    expect(a.engine.index.get(TARGET)?.docId).toBe(docIdR);
    // The displaced source is routed as a genuine delete (not left live-but-missing).
    expect(a.engine.index.get(OLD)?.deleted).toBe(true);
  });
});

describe("M3 live rename coalesce — requestRename vs an in-flight drain (F2)", () => {
  it("requestRename refuses a target that a drain has snapshotted but not yet read", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const T = p("notes/f2-target.md");
    const X = p("notes/f2-x.md");
    await durA.vault.writeAtomic(X, utf8("x source body unique"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.whenIdle();

    // T is physically present + buffered as an unbound external rename target.
    await durA.vault.writeAtomic(
      T,
      utf8("incoming external content, must not be clobbered, unique"),
    );
    emit(a, { type: "modify", path: T });

    // Start the drain WITHOUT awaiting: it snapshots T and clears renameBuf.targets synchronously, then
    // suspends on its first await — the window where the plain `renameBuf.targets.has(to)` guard misses T.
    const drain = internals(a).runRenameDrain();
    const ok = await a.engine.requestRename(X, T); // must STILL refuse — T is mid-drain, bytes unread
    await drain;
    expect(ok).toBe(false); // refused — the external target's bytes were not clobbered by the rename
  });
});

describe("M3 live rename coalesce — hard cap on the debounce window (F4)", () => {
  it("clamps the drain delay so a steady sub-window cadence never drains past the cap", () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    // window 300, cap 1000.
    const a = makeEngine(bus, durA, "device-a", { renameWindowMs: 300, renameWindowCapMs: 1000 });
    const delay = (now: number, firstArmedAt: number): number =>
      internals(a).renameDrainDelay(now, firstArmedAt);

    expect(delay(0, 0)).toBe(300); // fresh window: the full base debounce
    expect(delay(700, 0)).toBe(300); // 300ms cap budget left, base window fits → still 300
    // 250ms of cap budget left: the base 300ms window would overshoot the cap → CLAMP to 250 (F4).
    expect(delay(750, 0)).toBe(250);
    expect(delay(1000, 0)).toBe(0); // cap reached → drain immediately
    expect(delay(1500, 0)).toBe(0); // past the cap → still 0 (never negative)
  });
});
