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
function makeEngine(bus: InProcessBus, d: Durable, deviceId: string): Device {
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

describe("external-mv collision: deferral keeps M1a/M1b intact", () => {
  it("M1a: a closed-app delete on a NON-durable adapter still materializes back (reappears)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(false);
    const durB = newDurable(false);
    const NOTE = p("notes/a.md");
    await durA.vault.writeAtomic(NOTE, utf8("a body unique enough"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    await a.engine.stop();
    open.length = 0;
    await durA.vault.remove(NOTE);
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);
    expect(decode(await durA.vault.read(NOTE))).toBe("a body unique enough");
    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true);
  });

  it("M1b: a clean closed-app delete on a DURABLE adapter still auto-propagates", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const X = p("notes/x.md");
    await durA.vault.writeAtomic(X, utf8("x body unique enough"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    await a.engine.stop();
    open.length = 0;
    await durA.vault.remove(X);
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);
    expect(a2.engine.index.get(X)?.deleted).toBe(true);
    expect(decode(await durB.vault.read(X))).toBe("<absent>");
  });

  it("the deferred materialize MIRRORS markMaterialized (so a later clean delete can still propagate)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true); // a peer so the offline-restart repopulates the lost doc's live index entry
    const NOTE = p("notes/m.md");
    await durA.vault.writeAtomic(NOTE, utf8("materialize-mirror body, unique"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(NOTE)?.docId;
    if (docId === undefined) throw new Error("expected docId");

    // Stop A, CLEAR the base sidecar's materializedHash, then REMOVE the file. On A's restart,
    // applyDeferredLost sees a lost doc with NO materializedHash → the delete-candidate gate FAILS → it
    // MATERIALIZES the file back (M1a). The mirror must then RE-RECORD materializedHash (== the now-present
    // file's stamp) — without it a later clean closed-app delete would silently stop propagating (M1b).
    await a.engine.stop();
    open.length = 0;
    const basePath = p(`${CONFIG}/zync/base/${docId}.json`);
    const raw = await durA.vault.read(basePath);
    if (raw === null) throw new Error("expected base sidecar");
    const rec = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    delete rec.materializedHash;
    await durA.vault.writeAtomic(basePath, utf8(JSON.stringify(rec)));
    await durA.vault.remove(NOTE);

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);

    // The file was materialized back (M1a — NOT a delete); the MIRROR re-recorded materializedHash.
    expect(decode(await durA.vault.read(NOTE))).toBe("materialize-mirror body, unique");
    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true);
    expect(decode(await durB.vault.read(NOTE))).toBe("materialize-mirror body, unique"); // no spurious propagation
    const raw2 = await durA.vault.read(basePath);
    if (raw2 === null) throw new Error("expected base sidecar after restart");
    const rec2 = JSON.parse(new TextDecoder().decode(raw2)) as {
      materializedHash?: string;
      fileHash: string;
    };
    expect(rec2.materializedHash).toBeDefined();
    expect(rec2.materializedHash).toBe(rec2.fileHash); // confirmed-on-disk == the present content
  });
});

describe("external-mv collision: in-place clobber recovery", () => {
  it("a closed-app mv onto an occupied live path restores the occupant + parks the incoming, both survive", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const INCOMING = p("notes/incoming.md");
    const OCCUPANT = p("notes/occupant.md");
    await durA.vault.writeAtomic(INCOMING, utf8("INCOMING content, unique and substantial"));
    await durA.vault.writeAtomic(OCCUPANT, utf8("OCCUPANT content, unique and substantial"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const occDoc = a.engine.index.get(OCCUPANT)?.docId;

    await a.engine.stop();
    open.length = 0;
    await durA.vault.rename(INCOMING, OCCUPANT); // FakeVault.rename = move (overwrite target)
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);

    expect(decode(await durA.vault.read(OCCUPANT))).toBe(
      "OCCUPANT content, unique and substantial",
    );
    expect(a2.engine.index.get(OCCUPANT)?.docId).toBe(occDoc);
    const artifact = a2.engine.index.liveEntries().find(([pth]) => pth.includes("(conflict,"));
    if (artifact === undefined) throw new Error("expected a conflict artifact");
    const artifactPath = artifact[0];
    expect(decode(await durA.vault.read(artifactPath))).toBe(
      "INCOMING content, unique and substantial",
    );
    expect((await a2.engine.pendingDocs()).length).toBe(0);
    expect(b.engine.index.liveEntries().some(([pth]) => pth === artifactPath)).toBe(true); // same artifact on B
  });

  it("guard: an mv of content that is ALSO live elsewhere does NOT false-recover", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const DUP = "shared identical body present in two notes, substantial";
    await durA.vault.writeAtomic(p("notes/template.md"), utf8(DUP));
    await durA.vault.writeAtomic(p("notes/incoming.md"), utf8(DUP)); // same content as a STILL-LIVE note
    await durA.vault.writeAtomic(p("notes/occupant.md"), utf8("occupant body unique"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    await a.engine.stop();
    open.length = 0;
    await durA.vault.rename(p("notes/incoming.md"), p("notes/occupant.md"));
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);
    // isLiveElsewhere guard: incoming's content is live at template.md → NOT an in-place collision.
    expect(a2.engine.index.liveEntries().some(([pth]) => pth.includes("(conflict,"))).toBe(false);
  });

  it("two occupied paths overwritten with the same incoming content: incoming re-keyed to exactly one artifact", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const C = "shared incoming content, unique and substantial enough";
    await durA.vault.writeAtomic(p("notes/incoming.md"), utf8(C));
    await durA.vault.writeAtomic(p("notes/occ1.md"), utf8("occ1 original unique"));
    await durA.vault.writeAtomic(p("notes/occ2.md"), utf8("occ2 original unique"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const incDoc = a.engine.index.get(p("notes/incoming.md"))?.docId;

    await a.engine.stop();
    open.length = 0;
    // incoming.md vanishes; its content C lands on BOTH occ1.md and occ2.md (a cp+rm-style closed-app op).
    await durA.vault.writeAtomic(p("notes/occ1.md"), utf8(C));
    await durA.vault.writeAtomic(p("notes/occ2.md"), utf8(C));
    await durA.vault.remove(p("notes/incoming.md"));
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);

    // The incoming docId is bound LIVE at EXACTLY ONE path (its artifact), never two (the double-consume bug
    // would re-key it to a second artifact). No crash, converges.
    const incLivePaths = a2.engine.index
      .liveEntries()
      .filter(([, e]) => e.docId === incDoc)
      .map(([pth]) => pth);
    expect(incLivePaths.length).toBe(1);
    expect((await a2.engine.pendingDocs()).length).toBe(0);
  });
});
