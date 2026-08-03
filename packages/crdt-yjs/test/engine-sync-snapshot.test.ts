import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SyncEngine,
  type EnginePorts,
  type EngineConfig,
  SELFHEAL_BACKOFF_MS,
  SELFHEAL_MAX_NO_PROGRESS,
} from "@zync/core";
import { stampHash } from "@zync/core";
import type { DeviceId, IdentityPort, Sha256, VaultPath } from "@zync/core";
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

/**
 * `syncSnapshot()` — the ONE O(n) pending pass, partitioned for display.
 *
 * The load-bearing property is the SUM INVARIANT: `arriving + sending + stuck === pending`.
 * `sending` is a set difference, never its own clauses, so the partition cannot silently drop a
 * pending source the per-entry classifier never sees (dirty-with-no-entry, tombstoned-but-present,
 * open rename transactions, synthetic `rename-target:<path>` tokens).
 */

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
  docStore: FakeDocStore;
  crdt: YjsCrdtProvider;
  transport: InProcessTransport;
}

function makeDevice(
  bus: InProcessBus,
  deviceId: string,
  name: string,
  stateOverride?: MemEngineState,
): Device {
  const vault = new FakeVault();
  const docStore = new FakeDocStore();
  const crdt = new YjsCrdtProvider();
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault,
    crdt,
    transport,
    blobs: new FakeBlobStore(),
    docStore,
    clock: new FakeClock(),
    identity: identity(deviceId, name),
    engineState: stateOverride ?? new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault, docStore, crdt, transport };
}

/**
 * Advance fake time far enough to fire the full self-heal backoff schedule repeatedly, flushing
 * microtasks between ticks. Lifted from self-heal-pending.test.ts, which is where the bounded
 * self-heal's give-up path is established.
 */
async function driveSelfHeal(engine: SyncEngine, rounds: number): Promise<void> {
  const maxStep = Math.max(...SELFHEAL_BACKOFF_MS);
  for (let i = 0; i < rounds; i++) {
    await vi.advanceTimersByTimeAsync(maxStep + 100);
    await engine.whenIdle();
  }
}

describe("syncSnapshot — one pending pass, partitioned for display", () => {
  /** Engines to tear down. Tracked on creation so a throw before assignment cannot leak timers. */
  let open: Device[] = [];
  const track = (d: Device): Device => {
    open.push(d);
    return d;
  };

  afterEach(async () => {
    vi.useRealTimers();
    const devices = open;
    open = [];
    // allSettled, not sequential awaits: a rejection from the first stop must not strand the rest.
    await Promise.allSettled(devices.map((d) => d.engine.stop()));
  });

  /**
   * The partition test that actually exercises the partition: all THREE buckets non-empty at once,
   * so the `stuckSet ∩ pending` filter and the arriving/stuck disjointness are both under test.
   * (Asserting the sum at a converged fixed point is vacuous — every bucket is 0 there, so four
   * empty arrays would pass.)
   *
   * B's `setSyncedStamp` never persists, so nothing on B can ever re-ack. That is the established
   * way (self-heal-pending.test.ts test 2b) to drive the bounded self-heal to its give-up bound
   * through the PUBLIC surface — no private fields touched. Everything durably pending on B when it
   * gives up becomes stuck; docs introduced AFTER that are not in the stuck set.
   */
  it("keeps arriving, sending and stuck disjoint and summing when all three are non-empty", async () => {
    vi.useFakeTimers();
    const bus = new InProcessBus();
    const a = track(makeDevice(bus, "dev-a", "Device A"));
    const neverAcks = new MemEngineState();
    neverAcks.setSyncedStamp = (): Promise<void> => Promise.resolve();
    const b = track(makeDevice(bus, "dev-b", "Device B", neverAcks));

    await a.engine.start();
    await b.engine.start();

    // 1. A publishes the doc that will become STUCK on B.
    await a.vault.writeAtomic(path("notes/stuck.md"), utf8("cannot-clear"));
    await a.engine.waitConverged();
    await b.engine.whenIdle();

    // 2. Drive B's bounded self-heal to its give-up bound → what is pending on B now becomes stuck.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    b.engine.requestSelfHeal();
    await b.engine.whenIdle();
    await driveSelfHeal(b.engine, SELFHEAL_MAX_NO_PROGRESS + 2);
    await b.engine.whenIdle();
    warnSpy.mockRestore();
    expect(b.engine.stuckDocs().length).toBeGreaterThan(0);

    // 3. A SENDING doc: authored locally on B, so it is on disk and owes a push.
    await b.vault.writeAtomic(path("notes/outbound.md"), utf8("mine"));
    await b.engine.whenIdle();

    // 4. An ARRIVING doc: published by A AFTER the give-up (so it is not in B's stuck set) and
    //    absent from B's disk, which is the shape of a not-yet-materialized inbound note. The
    //    removal is the LAST mutation before the snapshot deliberately: a whenIdle() here would
    //    drain the rename buffer, apply the delete and tombstone the entry, leaving nothing live.
    await a.vault.writeAtomic(path("notes/inbound.md"), utf8("hello"));
    await a.engine.waitConverged();
    await b.engine.whenIdle();
    await b.vault.remove(path("notes/inbound.md"));

    // 5. Take the STUCK doc off disk too, so it satisfies the absence clause exactly like the
    //    arriving one. This is the F1 regression: `stuckDocIds` is drawn from durable pending,
    //    which includes unmaterialized content, so without clause 1 a stuck doc would be counted
    //    arriving FOREVER and the count could never drain. Only the stuck clause separates them.
    await b.vault.remove(path("notes/stuck.md"));

    const snap = await b.engine.syncSnapshot();

    // All three buckets genuinely populated — the partition is non-trivial.
    expect(snap.stuck.length).toBeGreaterThan(0);
    expect(snap.sending.length).toBeGreaterThan(0);
    // EXACTLY the inbound doc. Both absent-from-disk docs would qualify on absence alone, so a 2
    // here means the stuck one leaked into arriving.
    expect(snap.arriving.length).toBe(1);

    // Pairwise disjoint.
    expect(snap.arriving.filter((id) => snap.stuck.includes(id))).toEqual([]);
    expect(snap.sending.filter((id) => snap.stuck.includes(id))).toEqual([]);
    expect(snap.arriving.filter((id) => snap.sending.includes(id))).toEqual([]);

    // And they sum to pending exactly.
    expect(snap.arriving.length + snap.sending.length + snap.stuck.length).toBe(
      snap.pending.length,
    );
  });

  it("reports a live entry with no local file as ARRIVING, not sending", async () => {
    const bus = new InProcessBus();
    const a = track(makeDevice(bus, "dev-a", "Device A"));
    const b = track(makeDevice(bus, "dev-b", "Device B"));
    const P = path("notes/inbound.md");

    await a.engine.start();
    await b.engine.start();
    await a.vault.writeAtomic(P, utf8("hello"));
    await a.engine.waitConverged();
    await b.engine.whenIdle();

    // PRECONDITION: B really did materialize it. Without this the remove below would delete
    // nothing and emit nothing, and the assertion would pass for the wrong reason.
    expect(await b.vault.read(P)).not.toBeNull();

    // Remove the materialized file WITHOUT marking the doc dirty, which is exactly the shape of a
    // not-yet-materialized inbound note on a fresh device. LAST mutation before the snapshot: a
    // whenIdle() here would drain the rename buffer and tombstone the entry (see test 1).
    await b.vault.remove(P);

    const snap = await b.engine.syncSnapshot();
    expect(snap.arriving.length).toBe(1);
    expect(snap.sending).not.toContain(snap.arriving[0]);
    expect(snap.arriving.length + snap.sending.length + snap.stuck.length).toBe(
      snap.pending.length,
    );
  });

  /**
   * R1 WIRING: the engine must feed the partition EVERY live entry, not just the pending ones.
   * Mid-rename both keys are live under one docId — the new path holds the file and is typically
   * NOT pending, the old path is absent and is. Recording only pending entries hides the
   * materialized side and shows a purely OUTBOUND rename as arriving.
   *
   * Staged directly on the index because the real window is sub-second and unreachable from a rig.
   */
  it("does not call a doc arriving when it is live at a second, materialized path", async () => {
    const bus = new InProcessBus();
    const a = track(makeDevice(bus, "dev-a", "Device A"));
    const ON_DISK = path("notes/one.md");
    const ABSENT = path("notes/two.md");

    await a.engine.start();
    await a.vault.writeAtomic(ON_DISK, utf8("one"));
    await a.engine.waitConverged();
    const entry = a.engine.index.get(ON_DISK);
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    // Bind the SAME docId to a second live path that has no file, exactly as a rename does
    // between its two non-atomic LWW writes. The first path keeps its file and stays non-pending.
    a.engine.index.setStamp(ABSENT, entry.docId, entry.type, stampHash(entry.stamp) as Sha256);
    expect(await a.vault.read(ON_DISK)).not.toBeNull();
    expect(await a.vault.read(ABSENT)).toBeNull();

    const snap = await a.engine.syncSnapshot();
    expect(snap.pending).toContain(entry.docId);
    expect(snap.arriving).toEqual([]);
    expect(snap.sending).toContain(entry.docId);
    expect(snap.arriving.length + snap.sending.length + snap.stuck.length).toBe(
      snap.pending.length,
    );
  });

  /**
   * ORDER, not just membership. Needs THREE+ docs (a one-element array cannot distinguish order
   * from membership) and a STABLE pending set: the never-acking state keeps these docs pending
   * indefinitely, and whenIdle() quiesces the loop, so no reconcile can land between the two scans.
   */
  it("pendingDocs() returns exactly the snapshot's pending set, in the same order", async () => {
    const bus = new InProcessBus();
    const neverAcks = new MemEngineState();
    neverAcks.setSyncedStamp = (): Promise<void> => Promise.resolve();
    const a = track(makeDevice(bus, "dev-a", "Device A", neverAcks));

    await a.engine.start();
    for (const name of ["x", "y", "z", "w"])
      await a.vault.writeAtomic(path(`notes/${name}.md`), utf8(name));
    await a.engine.whenIdle();

    const snap = await a.engine.syncSnapshot();
    expect(snap.pending.length).toBeGreaterThanOrEqual(3);
    expect(await a.engine.pendingDocs()).toEqual(snap.pending);
  });
});
