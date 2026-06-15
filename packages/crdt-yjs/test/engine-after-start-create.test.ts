import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, OrphanMeta, VaultPath } from "@zync/core";
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
 * AFTER-START concurrent-create data-loss reproduction (Phase 0b-3 Fix 1).
 *
 * The in-process analogue of the skipped harness `concurrent-create` scenario: two
 * devices each create the SAME path AFTER engine start (so the create flows through
 * the watcher → `ingest.onVaultWrite`, NOT the bootstrap seed). The index `tree`
 * LWW binds the path to ONE winner docId; the loser docId is orphaned on its device.
 * The orphan sweep MUST recover the loser to a deterministic `(conflict, …)` path so
 * BOTH bodies survive on BOTH peers — never silent data loss.
 *
 * Pre-fix this FAILS: the after-start ingest path mints a docId but never writes the
 * doc's `meta.create` and never saves a docStore snapshot, so the sweep's `orphanData`
 * (which requires BOTH) skips the loser and its content is lost.
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

/** Drive BOTH engines to a joint fixed point (mirrors engine-integration's converge). */
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

describe("after-start concurrent create — LWW loser recovered (no data loss)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("two AFTER-START creates of the same path both survive (winner + recovered loser)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    const P = path("daily/x.md");
    const A_BODY = "A body — created offline on A\n";
    const B_BODY = "B body — created offline on B\n";

    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // Partition A; each device CREATES the same path with DIFFERENT content AFTER start
    // (the create flows through the watcher → ingest, NOT the bootstrap seed).
    a.transport.goOffline();
    await a.vault.writeAtomic(P, utf8(A_BODY));
    await b.vault.writeAtomic(P, utf8(B_BODY));
    // Settle each side's offline ingest before healing (whenIdle is safe offline).
    await a.engine.whenIdle();
    await b.engine.whenIdle();

    // Heal A and drive convergence.
    a.transport.goOnline();
    await converge(a, b);

    // Both devices agree byte-for-byte on the full synced vault.
    const treeA = a.engine.index
      .liveEntries()
      .map(([p]) => p)
      .sort();
    const treeB = b.engine.index
      .liveEntries()
      .map(([p]) => p)
      .sort();
    expect(treeA).toEqual(treeB);

    // The live path holds ONE of the two bodies (the LWW winner).
    const live = await readNote(a, P);
    expect(live).not.toBeNull();
    const winnerIsA = live === A_BODY;
    const winnerIsB = live === B_BODY;
    expect(winnerIsA || winnerIsB).toBe(true);

    // The loser was RECOVERED to a deterministic conflict path — not destroyed. There
    // is exactly one such artifact, identical on both devices.
    const conflictsA = treeA.filter((p) => p.includes("(conflict,"));
    const conflictsB = treeB.filter((p) => p.includes("(conflict,"));
    expect(conflictsA).toEqual(conflictsB);
    expect(conflictsA.length).toBe(1);
    const recoveredPath = path(conflictsA[0] ?? "");

    // The recovered copy carries the LOSING body.
    const losingBody = winnerIsA ? B_BODY : A_BODY;
    expect(await readNote(a, recoveredPath)).toBe(losingBody);
    expect(await readNote(b, recoveredPath)).toBe(losingBody);

    // BOTH bodies survive on BOTH peers.
    for (const d of [a, b]) {
      const bodies = new Set<string>();
      for (const { path: fp } of await d.vault.list()) {
        if (fp.startsWith(".obsidian/")) continue;
        const bytes = await d.vault.read(fp);
        if (bytes !== null) bodies.add(decode(bytes));
      }
      expect(bodies.has(A_BODY)).toBe(true);
      expect(bodies.has(B_BODY)).toBe(true);
    }

    // Both devices quiescent.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("after ingest of a first-seen path, the attached doc's meta.create is defined + snapshot saved", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    const P = path("focused.md");

    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // First-seen create AFTER start: ingest mints a new docId for this path.
    await a.vault.writeAtomic(P, utf8("focused body\n"));
    await a.engine.whenIdle();

    const entry = a.engine.index.get(P);
    expect(entry).toBeDefined();
    const docId = entry?.docId;
    expect(docId).toBeDefined();
    if (docId === undefined) return;

    // A docStore snapshot was saved for the freshly-minted docId, AND that snapshot
    // carries the create-meta the orphan sweep needs to recover an LWW loser.
    const snap = await a.docStore.load(docId);
    expect(snap).not.toBeNull();
    if (snap === null) return;
    const doc = a.crdt.loadDoc(docId, snap);
    const meta = doc.getMap<OrphanMeta>("meta").get("create");
    doc.destroy();
    expect(meta).toBeDefined();
    expect(meta?.originalPath).toBe(P);
    expect(meta?.createdBy).toBe("dev-a");
    expect(typeof meta?.createdTs).toBe("string");
  });
});
