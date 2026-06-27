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
describe("M2 — lastLivePath maintenance", () => {
  it("a converged note's lastLivePath is its live path; it survives restart", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const NOTE = p("notes/alpha.md");
    const CONTENT = "STATUS: alpha\n\nunique body";
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.waitConverged();
    const docId = a.engine.index.get(NOTE)?.docId;
    if (docId === undefined) throw new Error("expected docId");
    expect(await durA.engineState.getLastLivePath(docId)).toBe(NOTE);

    await a.engine.stop();
    open.length = 0;
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine);
    await a2.engine.start();
    await a2.engine.waitConverged();
    expect(await durA.engineState.getLastLivePath(docId)).toBe(NOTE);
  });

  it("a deleted doc is delete-observed before its snapshot is gone", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const NOTE = p("notes/beta.md");
    await durA.vault.writeAtomic(NOTE, utf8("beta unique body"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.waitConverged();
    const docId = a.engine.index.get(NOTE)?.docId;
    if (docId === undefined) throw new Error("expected docId");
    await durA.vault.remove(NOTE); // runtime delete (watcher fires onDelete)
    await a.engine.waitConverged();
    expect(await durA.engineState.wasDeleted(docId)).toBe(true);
  });
});

describe("M2 — displacement discriminator: recover a rename-collision loser, skip a delete", () => {
  // SETUP MECHANISM: a single RUNNING engine and a RUNTIME rename collision (NOT an offline/bootstrap
  // rename, which M1b would read as a delete). The loser is first renamed away from its create-path (so
  // its create-path is tombstoned and lastLivePath != originalPath — a TRUE rename-loser), then a SECOND
  // note is renamed onto the loser's live path, flipping the index LWW register and DISPLACING the loser
  // into an orphan. The engine's real runOrphanSweep (driven by waitConverged) must then RECOVER it.
  // NB: onRename does NOT guard a runtime collision — engine-mediated renames refuse BEFORE the move via
  // SyncEngine.requestRename (a path the low-level vault.rename used here bypasses), so this runtime
  // collision faithfully reaches the displacement discriminator. Single-engine + runtime rename makes the
  // collision and the LWW outcome DETERMINISTIC (no Yjs client-id-ordering coin-flip), so this is not
  // flaky. The faithful two-device CONCURRENT-relay path is the T6 HARNESS's job (the in-process transport
  // cannot materialize a partition-born winner's content on a non-owning device).
  it("a displaced rename-loser (create-path tombstoned) is recovered, not dropped", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const ORIG = p("notes/orig.md"); // the loser's CREATE path
    const SHARED = p("notes/shared.md"); // the contested path
    const L = p("notes/a.md"); // the displacer
    await durA.vault.writeAtomic(ORIG, utf8("content of LOSER"));
    await durA.vault.writeAtomic(L, utf8("content of L"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.waitConverged();
    const loserId = a.engine.index.get(ORIG)?.docId;
    if (loserId === undefined) throw new Error("expected a live loser docId");

    // (1) Rename the loser orig.md -> shared.md (RUNTIME onRename). Its create-path is now tombstoned;
    // lastLivePath[loser] = shared.md (DIVERGED from meta.originalPath = orig.md — the rename-loser case
    // the OLD create-meta discriminator would WRONGLY skip).
    await durA.vault.rename(ORIG, SHARED);
    await a.engine.waitConverged();
    expect(await durA.engineState.getLastLivePath(loserId)).toBe(SHARED);
    expect(a.engine.index.get(SHARED)?.docId).toBe(loserId);

    // (2) Rename L a.md -> shared.md (RUNTIME onRename). The per-path LWW register flips shared.md to L's
    // docId, DISPLACING the loser: its snapshot + lastLivePath survive, but shared.md is now a DIFFERENT
    // live docId. The orphan sweep (run by waitConverged) must recover the loser.
    await durA.vault.rename(L, SHARED);
    await a.engine.waitConverged();

    // INVARIANTS: BOTH contents survive LIVE on disk, AND the loser was recovered to its deterministic
    // (conflict, ...) artifact path (derived from meta.originalPath = orig.md, device-independent).
    const liveA = a.engine.index.liveEntries();
    const texts = (await Promise.all(liveA.map(([pth]) => durA.vault.read(p(pth))))).map(decode);
    expect(texts).toContain("content of L"); // the displacer is live at shared.md
    expect(texts).toContain("content of LOSER"); // the displaced loser survives — NOT dropped
    expect(liveA.some(([pth]) => pth.includes("(conflict,"))).toBe(true);
    // The recovered binding REUSES the loser's original docId (no new create).
    const recovered = liveA.find(([pth]) => pth.includes("(conflict,"));
    expect(recovered?.[1].docId).toBe(loserId);
    expect((await a.engine.pendingDocs()).length).toBe(0);
  });

  it("a delete that races a same-path reuse is NOT resurrected", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const X = p("notes/x.md");
    await durA.vault.writeAtomic(X, utf8("original x content"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    await durA.vault.remove(X); // A deletes X (delete-observed)
    await a.engine.waitConverged();
    await durB.vault.writeAtomic(X, utf8("brand new x content")); // B reuses the path with a new doc
    await converge(a, b);
    const bytes = await durA.vault.read(X);
    expect(bytes === null ? "" : decode(bytes)).toBe("brand new x content"); // the reuse, not a resurrect
    expect(a.engine.index.liveEntries().filter(([pth]) => pth.includes("(conflict,")).length).toBe(
      0,
    );
  });

  // M2 ENGINE-MEDIATED RENAME GUARD (refuse-before-move). requestRename is the path /fs/rename routes
  // through; it refuses BEFORE the OS move when the target is an OCCUPIED live different-docId path (the
  // move would clobber the occupant's bytes and lose content). A FREE / same-docId / tombstoned target
  // proceeds with docId continuity. (External delete+create renames bypass this — the bootstrap
  // displacement detector handles those; the discriminator tests above cover that path.)
  it("requestRename onto a FREE path moves with docId continuity", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    await durA.vault.writeAtomic(p("notes/a.md"), utf8("a body unique"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.waitConverged();
    const docId = a.engine.index.get(p("notes/a.md"))?.docId;
    const ok = await a.engine.requestRename(p("notes/a.md"), p("notes/moved.md"));
    await a.engine.waitConverged();
    expect(ok).toBe(true);
    expect(a.engine.index.get(p("notes/moved.md"))?.docId).toBe(docId); // continuity
    expect(a.engine.index.get(p("notes/a.md"))?.deleted).toBe(true);
  });

  it("requestRename onto an OCCUPIED live different-docId path is REFUSED — both files intact + notice", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    await durA.vault.writeAtomic(p("notes/occupant.md"), utf8("occupant body"));
    await durA.vault.writeAtomic(p("notes/incoming.md"), utf8("incoming body"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.waitConverged();
    const occDoc = a.engine.index.get(p("notes/occupant.md"))?.docId;
    const incDoc = a.engine.index.get(p("notes/incoming.md"))?.docId;

    const ok = await a.engine.requestRename(p("notes/incoming.md"), p("notes/occupant.md"));
    await a.engine.waitConverged();

    expect(ok).toBe(false); // refused
    expect(a.engine.index.get(p("notes/occupant.md"))?.docId).toBe(occDoc); // occupant intact
    expect(a.engine.index.get(p("notes/incoming.md"))?.docId).toBe(incDoc); // incoming NOT moved/lost
    expect(decode(await durA.vault.read(p("notes/occupant.md")))).toBe("occupant body");
    expect(decode(await durA.vault.read(p("notes/incoming.md")))).toBe("incoming body");
    expect(a.engine.inbox.list().some((e) => e.detail?.includes("was refused"))).toBe(true);
  });

  // ISSUE 2 (regression coverage for the orphan-sweep DISPLACEMENT DISCRIMINATOR). Task 5's local onRename
  // guard intercepts the local-rename mechanism Task 4's recover test used, so reverting the discriminator
  // now fails NOTHING in-process. This reaches the discriminator WITHOUT the local guard by MANUFACTURING
  // the displaced-orphan state directly via the durable stores + index: a docId with a docStore snapshot +
  // create-meta, live NOWHERE, lastLivePath set to a path the index now binds to a DIFFERENT live docId,
  // and NOT wasDeleted — exactly what runOrphanSweep's orphanData reads to recover a rename-loser. It MUST
  // fail if the discriminator is reverted to the old create-meta form (live = index.get(meta.originalPath)).
  it("orphan-sweep recovers a directly-manufactured rename-loser displacement (no local guard)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const P = p("notes/p.md"); // L's CREATE path (== meta.originalPath; the OLD discriminator keyed off it)
    const Q = p("notes/q.md"); // L's renamed (last-live) path — the contested path
    const D = p("notes/d.md"); // a SECOND real doc (WITH a snapshot) that will displace L at Q
    const L_BODY = "CONTENT-OF-L distinct";
    const D_BODY = "CONTENT-OF-SQUATTER-D";
    await durA.vault.writeAtomic(P, utf8(L_BODY));
    await durA.vault.writeAtomic(D, utf8(D_BODY));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.waitConverged();
    const lId = a.engine.index.get(P)?.docId;
    const dId = a.engine.index.get(D)?.docId;
    if (lId === undefined || dId === undefined) throw new Error("expected live docIds for L and D");

    // (1) RUNTIME rename L p.md -> q.md: L is live at q.md, p.md tombstoned, lastLivePath[L]=q.md (a TRUE
    // rename — lastLivePath != create-meta.originalPath = p.md). L has a docStore snapshot + create-meta.
    await durA.vault.rename(P, Q);
    await a.engine.waitConverged();
    expect(await durA.engineState.getLastLivePath(lId)).toBe(Q);
    expect(a.engine.index.get(Q)?.docId).toBe(lId);

    // (2) MANUFACTURE the displacement WITHOUT the onRename guard: move D's index binding d.md -> q.md via a
    // low-level index op (index.rename — NOT onRename, the mechanism the local collision guard cannot
    // intercept), then ALIGN disk so the manufactured state CONVERGES: q.md := D's content, d.md removed.
    // L is now live NOWHERE, but keeps its snapshot + create-meta + lastLivePath[L]=q.md (its RENAMED path,
    // DIVERGED from meta.originalPath=p.md) and is NOT wasDeleted — the precise displaced-rename-loser state
    // the OLD create-meta discriminator (live=index.get(meta.originalPath=p.md)) would WRONGLY skip.
    a.engine.index.rename(D, Q);
    await durA.vault.writeAtomic(Q, utf8(D_BODY)); // q.md now holds D's content (converges with D's stamp)
    await durA.vault.remove(D); // align disk with the d.md tombstone the index.rename laid
    expect(a.engine.index.get(Q)?.docId).toBe(dId);
    expect(a.engine.index.get(Q)?.docId).not.toBe(lId); // L is displaced — live nowhere
    expect(a.engine.index.liveEntries().some(([, e]) => e.docId === lId)).toBe(false);
    expect(await durA.engineState.getLastLivePath(lId)).toBe(Q); // lastLivePath != originalPath (true rename)
    expect(await durA.engineState.wasDeleted(lId)).toBe(false); // NOT a delete — must be recovered

    // (3) Trigger a sweep (waitConverged runs runOrphanSweep). The discriminator sees: L live nowhere,
    // lastLivePath[L]=q.md now bound to D (a DIFFERENT live docId), not wasDeleted ⇒ RECOVER L. (The OLD
    // create-meta discriminator checks index.get(p.md) — a tombstone ⇒ deleted ⇒ it returns null ⇒ L is
    // DROPPED, which is exactly what this test FAILS on if the discriminator is reverted.)
    await a.engine.waitConverged();

    // L is recovered to a (conflict, ...) artifact REUSING L's docId — the discriminator's recovery.
    const recovered = a.engine.index.liveEntries().find(([, e]) => e.docId === lId);
    expect(recovered).toBeDefined(); // L is live again (recovered) — NOT dropped
    expect(recovered?.[0].includes("(conflict,")).toBe(true);
    expect(decode(await durA.vault.read(p(recovered?.[0] ?? "")))).toBe(L_BODY); // L's content, intact
    expect((await a.engine.pendingDocs()).length).toBe(0); // converged — no wedge
  });

  it("an INBOUND delete sets deleteObserved (so a later same-path reuse cannot resurrect)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const X = p("notes/x.md");
    await durA.vault.writeAtomic(X, utf8("x body unique"));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(X)?.docId;
    if (docId === undefined) throw new Error("expected docId");
    // A deletes X; B processes the INBOUND tombstone (structural reconcile) and removes its file.
    await durA.vault.remove(X);
    await converge(a, b);
    expect(await durB.engineState.wasDeleted(docId)).toBe(true); // inbound delete recorded it
  });

  it("the bootstrap backstop CLEARS a stale deleteObserved for a live doc", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const NOTE = p("notes/live.md");
    await durA.vault.writeAtomic(NOTE, utf8("live body"));
    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.waitConverged();
    const docId = a.engine.index.get(NOTE)?.docId;
    if (docId === undefined) throw new Error("expected docId");
    // Manufacture a stale deleteObserved on a LIVE doc (as if a resurrect didn't clear it).
    await durA.engineState.markDeleted(docId);
    expect(await durA.engineState.wasDeleted(docId)).toBe(true);
    // Restart → the backstop runs over live entries and clears it.
    await a.engine.stop();
    open.length = 0;
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine);
    await a2.engine.start();
    await a2.engine.waitConverged();
    expect(await durA.engineState.wasDeleted(docId)).toBe(false); // cleared by the backstop
  });
});
