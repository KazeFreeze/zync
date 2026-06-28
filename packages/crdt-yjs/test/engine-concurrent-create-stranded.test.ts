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
  type InProcessTransport,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

/**
 * STRANDED LIVE-DISK reproduction (concurrent-create split-brain).
 *
 * The real-relay harness `concurrent-create` scenario leaves the RECONNECTING device with the
 * LOSER's bytes on the live path's disk while the index binds the WINNER doc. The synchronous
 * in-process bus converges cleanly and so HIDES this — `materializeLiveDiskContent`'s anti-clobber
 * guard never gets a chance to misfire. So we drive a normal concurrent-create converge (both
 * devices correct), then STAGE that exact stranded state on device-a (overwrite the live disk with
 * the loser's bytes via `writeSilently`, so the watcher never re-ingests them) and assert the engine
 * re-materializes the live disk back to the converged winner.
 *
 * Pre-fix this FAILS: the guard skips because the stale disk bytes (the loser's, a KNOWN doc's
 * content now live at the conflict path) do not equal the winner doc's `base.fileHash`, so the live
 * disk stays stuck on the loser's body forever and `pendingDocs` never drains.
 */

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

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

function makeDevice(bus: InProcessBus, deviceId: string, name: string): Device {
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
    engineState: new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault, docStore, crdt, transport };
}

async function readNote(d: Device, p: VaultPath): Promise<string | null> {
  const bytes = await d.vault.read(p);
  return bytes === null ? null : decode(bytes);
}

async function converge(a: Device, b: Device): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await a.engine.waitConverged();
    await b.engine.waitConverged();
    const pa = await a.engine.pendingDocs();
    const pb = await b.engine.pendingDocs();
    if (pa.length === 0 && pb.length === 0) return;
  }
  throw new Error("converge: two engines did not reach a joint fixed point");
}

/** Drive ONE device's convergence loop, tolerating the pre-fix throw (it cannot settle a stranded
 *  live disk), until it quiesces or we run out of bounded rounds. */
async function driveOne(d: Device, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    try {
      await d.engine.waitConverged();
    } catch {
      // pre-fix: waitConverged throws when the stranded live disk never settles.
    }
    if ((await d.engine.pendingDocs()).length === 0) return;
  }
}

describe("concurrent-create — reconnecting device's stranded live disk is re-materialized", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("re-materializes the live path to the converged winner when the disk holds the loser's bytes", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    const P = path("daily/2026-06-14.md");
    const A_BODY = "# 2026-06-14 (authored by A)\n\nA content.\n";
    const B_BODY = "# 2026-06-14 (authored by B)\n\nB content.\n";

    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // Concurrent create of the SAME path with different bodies, then heal + converge.
    a.transport.goOffline();
    await a.vault.writeAtomic(P, utf8(A_BODY));
    await b.vault.writeAtomic(P, utf8(B_BODY));
    await a.engine.whenIdle();
    await b.engine.whenIdle();
    a.transport.goOnline();
    await converge(a, b);

    // The in-process bus converges cleanly: the live path holds the LWW winner, the loser is
    // recovered to exactly one conflict artifact. (Winner is nondeterministic by Yjs clientID.)
    const winnerBody = await readNote(a, P);
    expect(winnerBody === A_BODY || winnerBody === B_BODY).toBe(true);
    const loserBody = winnerBody === A_BODY ? B_BODY : A_BODY;
    const conflicts = a.engine.index
      .liveEntries()
      .map(([p]) => p)
      .filter((p) => p.includes("(conflict,"));
    expect(conflicts.length).toBe(1);
    const C = path(conflicts[0] ?? "");
    expect(await readNote(a, C)).toBe(loserBody);

    // STAGE THE STRANDED STATE the real relay produces: device-a's live-path disk holds the
    // LOSER's bytes (engine-known content now living at the conflict path), while the index still
    // binds the WINNER doc. Silent write ⇒ the watcher never re-ingests it.
    a.vault.writeSilently(P, utf8(loserBody));
    expect(await readNote(a, P)).toBe(loserBody); // clobber staged

    // Drive device-a's convergence. The engine MUST re-materialize the live path back to the winner.
    await driveOne(a);

    expect(await readNote(a, P)).toBe(winnerBody); // ← live disk repaired to the converged winner
    expect(await a.engine.pendingDocs()).toEqual([]); // ← quiescent again
    expect(await readNote(a, C)).toBe(loserBody); // conflict artifact untouched
    // Both bodies still survive on device-a.
    const bodies = new Set<string>();
    for (const { path: fp } of await a.vault.list()) {
      if (fp.startsWith(".obsidian/")) continue;
      const bytes = await a.vault.read(fp);
      if (bytes !== null) bodies.add(decode(bytes));
    }
    expect(bodies.has(A_BODY)).toBe(true);
    expect(bodies.has(B_BODY)).toBe(true);
  });
});
