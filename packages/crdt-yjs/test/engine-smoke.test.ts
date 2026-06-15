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
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const A_MD = path("a.md");

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

/** One full device: its own vault, provider, transport, and engine. */
interface Device {
  engine: SyncEngine;
  vault: FakeVault;
}

function makeDevice(bus: InProcessBus, deviceId: string, name: string): Device {
  const vault = new FakeVault();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(deviceId, name),
    engineState: new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0, // immediate (microtask) bumps → deterministic
  };
  return { engine: new SyncEngine(ports, config), vault };
}

/** Read a note from a device's vault as text (or null if absent). */
async function readNote(d: Device, p: VaultPath): Promise<string | null> {
  const bytes = await d.vault.read(p);
  return bytes === null ? null : decode(bytes);
}

/** Drive BOTH engines to a joint fixed point: alternate waitConverged until both are clean. */
async function converge(a: Device, b: Device): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await a.engine.waitConverged();
    await b.engine.waitConverged();
    const pa = await a.engine.pendingDocs();
    const pb = await b.engine.pendingDocs();
    if (pa.length === 0 && pb.length === 0) return;
  }
  throw new Error("converge: two engines did not reach a joint fixed point");
}

describe("SyncEngine two-engine smoke (deterministic — no setTimeout polling)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("seed → propagate: A's existing note lazy-attaches to an empty B", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A already has a.md before it starts; B starts empty.
    await a.vault.writeAtomic(A_MD, utf8("hello"));

    await a.engine.start();
    await b.engine.start();

    await converge(a, b);

    // B pulled a.md == "hello" via lazy-attach; both engines have no pending docs.
    expect(await readNote(b, A_MD)).toBe("hello");
    expect(await readNote(a, A_MD)).toBe("hello");
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("edit converges both ways", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    await a.vault.writeAtomic(A_MD, utf8("hello"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // Edit on A → its vault `modify` event fires onWrite → ingest → converges to B.
    await a.vault.writeAtomic(A_MD, utf8("hello world"));
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("hello world");

    // Now edit on B → converges back to A.
    await b.vault.writeAtomic(A_MD, utf8("hello world!!!"));
    await converge(a, b);
    expect(await readNote(a, A_MD)).toBe("hello world!!!");
  });

  it("pendingDocs is empty once converged, on both engines, across an edit", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    await a.vault.writeAtomic(A_MD, utf8("hello"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    // A converged shared note leaves BOTH engines with nothing pending.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);

    // An edit reintroduces work; with the index-map origin-tagging fix the new stamp
    // relays LIVE, so B catches up eagerly. After re-converging, pendingDocs is empty
    // again on both and B holds the new content. (waitConverged gates on pendingDocs —
    // a non-empty set is exactly what blocks convergence from being declared early; the
    // non-empty-under-partition case is exercised in the §15 integration suite.)
    await a.vault.writeAtomic(A_MD, utf8("hello world"));
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("hello world");
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("observability seam: getAuthority / ensureNoteAttached / counts (0b-3)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    await a.vault.writeAtomic(A_MD, utf8("seam content"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // Index doc snapshot has bytes once started.
    expect(a.engine.indexSnapshotBytes()).toBeGreaterThan(0);

    // getAuthority returns the canonical authority; binding flips it active-bound.
    const auth = a.engine.getAuthority(A_MD);
    expect(auth.state).toBe("inactive");
    auth.bindEditor("pane-1");
    expect(auth.state).toBe("active-bound");

    // ensureNoteAttached (online path via runCatchUp) attaches the open note's doc.
    const doc = await a.engine.ensureNoteAttached(A_MD);
    expect(doc).toBeDefined();
    expect(doc?.getText()).toBe("seam content");
    expect(a.engine.getAttachedDoc(A_MD)).toBe(doc); // canonical instance
    expect(a.engine.attachedDocCount()).toBeGreaterThanOrEqual(1);
    auth.unbindEditor("pane-1");
  });
});

describe("SyncEngine projector mode (ingestDisabled, 0b-3 Part C)", () => {
  it("does NOT ingest a local write when ingestDisabled is true", async () => {
    const bus = new InProcessBus();
    const vault = new FakeVault();
    const engine = new SyncEngine(
      {
        vault,
        crdt: new YjsCrdtProvider(),
        transport: bus.connect(),
        blobs: new FakeBlobStore(),
        docStore: new FakeDocStore(),
        clock: new FakeClock(),
        identity: identity("dev-proj", "Projector"),
        engineState: new MemEngineState(),
      },
      { configDir: ".obsidian", maxProseBytes: 1_000_000, substrate: "yjs", ingestDisabled: true },
    );
    await engine.start();

    // A local write fires onWrite, but ingest is disabled → no index entry, nothing pending.
    await vault.writeAtomic(A_MD, utf8("projected only"));
    await engine.whenIdle();

    expect(engine.index.get(A_MD)).toBeUndefined();
    expect(await engine.pendingDocs()).toEqual([]);
    await engine.stop();
  });
});
