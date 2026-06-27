import { describe, it, expect, afterEach } from "vitest";
import {
  SyncEngine,
  type EnginePorts,
  type EngineConfig,
  type DeviceId,
  type DocId,
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

/** Read materializedHash straight off the on-disk base sidecar (robust to engine field visibility). */
async function materializedHashOnDisk(d: Durable, docId: string): Promise<string | undefined> {
  const raw = await d.vault.read(p(`${CONFIG}/zync/base/${docId}.json`));
  if (raw === null) return undefined;
  return (JSON.parse(new TextDecoder().decode(raw)) as { materializedHash?: string })
    .materializedHash;
}

describe("M1b — materializedHash observed at bootstrap", () => {
  it("a present, converged note has materializedHash set to its content hash", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(false);
    const durB = newDurable(false);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    const entry = a.engine.index.get(NOTE);
    const docId = entry?.docId;
    if (docId === undefined) throw new Error("expected a live docId");
    const mh = await materializedHashOnDisk(durA, docId);
    expect(mh).toBeDefined();
    // Equals the index stamp's hash-part (confirmed-on-disk == current index content).
    expect(mh).toBe(entry?.stamp.split(":")[0]);
  });

  it("read()-recheck: a file MISSING from list() but still on disk is NOT treated as a delete", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true); // durable: a real delete WOULD propagate (Task 6); proves the recheck saves it
    const durB = newDurable(true);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    await a.engine.stop();
    open.length = 0;
    // INCOMPLETE listing: the file is on disk, but list() omits it; read() still returns it.
    durA.vault.hideFromList(NOTE);

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);

    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true); // NOT a delete: present on disk
    expect(decode(await durB.vault.read(NOTE))).toBe(CONTENT);
  });

  it("durable adapter, clean signal: a closed-app delete PROPAGATES (peer loses the file)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
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

    expect(a2.engine.index.get(NOTE)?.deleted).toBe(true);
    expect(decode(await durA.vault.read(NOTE))).toBe("<absent>");
    expect(decode(await durB.vault.read(NOTE))).toBe("<absent>");
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete")).toEqual([]);
  });

  it("non-durable adapter: a closed-app delete is HELD — reappears + a pending-delete inbox entry", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(false);
    const durB = newDurable(false);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
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

    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true);
    expect(decode(await durA.vault.read(NOTE))).toBe(CONTENT);
    expect(decode(await durB.vault.read(NOTE))).toBe(CONTENT);
    const pend = a2.engine.inbox.list().filter((e) => e.kind === "pending-delete");
    expect(pend.map((e) => e.path)).toEqual([NOTE]);
    expect((await a2.engine.pendingDocs()).length).toBe(0);
  });

  it("durable adapter, SUBTREE drop: many siblings vanish -> held for confirm, not auto-propagated", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const files = ["notes/proj/a.md", "notes/proj/b.md", "notes/proj/c.md"].map(p);
    for (const f of files) await durA.vault.writeAtomic(f, utf8(`unique body of ${f}`));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    await a.engine.stop();
    open.length = 0;
    for (const f of files) await durA.vault.remove(f);

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);

    for (const f of files) {
      expect(a2.engine.index.get(f)?.deleted).not.toBe(true);
      expect(decode(await durA.vault.read(f))).toContain("unique body");
    }
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete").length).toBe(3);
  });

  it("confirmPendingDelete: removes the held file, propagates the delete, resolves the inbox entry", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(false);
    const durB = newDurable(false);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
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
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete").length).toBe(1);

    await a2.engine.confirmPendingDelete(NOTE);
    await converge(a2, b);

    expect(a2.engine.index.get(NOTE)?.deleted).toBe(true);
    expect(decode(await durA.vault.read(NOTE))).toBe("<absent>");
    expect(decode(await durB.vault.read(NOTE))).toBe("<absent>");
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete")).toEqual([]);
    expect((await a2.engine.pendingDocs()).length).toBe(0);
  });

  it("dismissPendingDelete: keeps the file, resolves the inbox entry, no tombstone", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(false);
    const durB = newDurable(false);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
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

    await a2.engine.dismissPendingDelete(NOTE);
    await converge(a2, b);

    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true);
    expect(decode(await durA.vault.read(NOTE))).toBe(CONTENT);
    expect(decode(await durB.vault.read(NOTE))).toBe(CONTENT);
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete")).toEqual([]);
  });

  it("durable: a closed-app vanish of a doc with an UNPUSHED edit (base ahead) materializes back, not deletes", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(NOTE)?.docId;
    if (docId === undefined) throw new Error("expected a live docId");

    await a.engine.stop();
    open.length = 0;
    // Simulate an offline UNPUSHED edit whose debounced stamp-bump never flushed: advance the base sidecar
    // (baseText + fileHash) to NEW content while leaving materializedHash + the index stamp at the OLD hash,
    // and mark the doc dirty. Then the file vanishes closed-app.
    const NEW = CONTENT + "\n\nan unpushed offline edit";
    const basePath = p(`.obsidian/zync/base/${docId}.json`);
    const rawBase = await durA.vault.read(basePath);
    if (rawBase === null) throw new Error("expected a base sidecar");
    const rec = JSON.parse(new TextDecoder().decode(rawBase)) as Record<string, unknown>;
    const { sha256OfText } = await import("@zync/core");
    rec.baseText = NEW;
    rec.fileHash = await sha256OfText(NEW); // base AHEAD of materializedHash (still the old hash)
    await durA.vault.writeAtomic(basePath, utf8(JSON.stringify(rec)));
    await durA.engineState.markDirty(docId);
    await durA.vault.remove(NOTE);

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);

    // The unpushed edit is PRESERVED (materialized back), the doc is NOT tombstoned, and it converges.
    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true);
    expect(decode(await durA.vault.read(NOTE))).toBe(NEW);
    expect((await a2.engine.pendingDocs()).length).toBe(0);
  });

  it("confirmPendingDelete is idempotent under concurrent double-confirm (no empty-hash resurrect)", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(false);
    const durB = newDurable(false);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
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
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete").length).toBe(1);

    // Fire two confirms concurrently — the race the fix closes.
    await Promise.all([a2.engine.confirmPendingDelete(NOTE), a2.engine.confirmPendingDelete(NOTE)]);
    await converge(a2, b);

    expect(a2.engine.index.get(NOTE)?.deleted).toBe(true);
    expect(decode(await durA.vault.read(NOTE))).toBe("<absent>");
    expect(decode(await durB.vault.read(NOTE))).toBe("<absent>"); // delete APPLIED, not resurrected
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete")).toEqual([]);
  });

  it("confirmPendingDelete with an ABSENT base record does NOT lay an empty-hash tombstone or remove the file", async () => {
    // The materializedHash-no-fallback guard (engine.ts confirmPendingDelete): if base.load() returns
    // null for a still-LIVE entry, the fix resolves the inbox and returns WITHOUT tombstoning. The
    // pre-fix code fell back to fileHash ?? empty -> an empty-hash tombstone + file removal, which peers
    // RESURRECT (their content hash != empty -> edit-beats-delete). A same-path double-confirm can't
    // reach this (the BaseStore per-doc lock serializes both base.load() calls before either base.delete,
    // so the 2nd confirm always reads a non-null record) — so we drive the null-rec branch directly.
    const bus = new InProcessBus();
    const durA = newDurable(false);
    const durB = newDurable(false);
    await durA.vault.writeAtomic(NOTE, utf8(CONTENT));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docId = a.engine.index.get(NOTE)?.docId;
    if (docId === undefined) throw new Error("expected a live docId");

    await a.engine.stop();
    open.length = 0;
    await durA.vault.remove(NOTE); // closed-app delete -> HELD on the non-durable adapter
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete").length).toBe(1);
    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true); // materialized back, LIVE

    // Drive the null-rec branch: remove the base sidecar OUT-OF-BAND (raw vault, bypassing the BaseStore
    // doc lock) while the index entry is still LIVE. base.load() now returns null at confirm time.
    const basePath = p(`${CONFIG}/zync/base/${docId}.json`);
    await durA.vault.remove(basePath);
    expect(await durA.vault.read(basePath)).toBeNull();

    await a2.engine.confirmPendingDelete(NOTE);

    // No materializedHash to tombstone with -> resolve the inbox, leave the file, lay NO tombstone.
    // (Asserted on a2's LOCAL state immediately, BEFORE any convergence: the pre-fix empty-hash
    // tombstone + remove would already have flipped both of these.)
    expect(a2.engine.index.get(NOTE)?.deleted).not.toBe(true); // NOT tombstoned
    expect(decode(await durA.vault.read(NOTE))).toBe(CONTENT); // file PRESERVED
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete")).toEqual([]); // inbox resolved
  });

  it("durable MASS-WIPE: the suspicious-fraction denominator excludes never-materialized docs", async () => {
    // The mass-wipe quarantine (isSuspiciousDeleteBatch) compares the delete batch against a denominator.
    // Using ALL live prose (a superset of confirmed-materialized) inflates the denominator and skews toward
    // auto-propagate. The fix: never-materialized-vanished docs (never confirmed on disk) must NOT dilute it.
    // Setup (all root-level so the subtree-drop branch is inert; only the fraction branch is active):
    //   (a) 4 present materialized + (b) 7 materialized-then-deleted + (c) 4 never-materialized-vanished = 15.
    //   Old denom 15: 7 > 0.5*15=7.5? NO  -> auto-propagate (the bug, on a durable adapter).
    //   New denom 11 (a+b, >= MASS_DELETE_MIN): 7 > 0.5*11=5.5? YES -> mass wipe -> HELD.
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const present = ["p0.md", "p1.md", "p2.md", "p3.md"].map(p);
    const deleted = ["d0.md", "d1.md", "d2.md", "d3.md", "d4.md", "d5.md", "d6.md"].map(p);
    const stripped = ["s0.md", "s1.md", "s2.md", "s3.md"].map(p);
    const all = [...present, ...deleted, ...stripped];
    for (const f of all) await durA.vault.writeAtomic(f, utf8(`unique body of ${f}`));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    const docIdOf = (f: VaultPath): string => {
      const id = a.engine.index.get(f)?.docId;
      if (id === undefined) throw new Error(`no docId for ${f}`);
      return id;
    };
    const strippedIds = stripped.map(docIdOf);

    await a.engine.stop();
    open.length = 0;
    // (b) genuine closed-app deletes (materialized -> vanished == delete candidates).
    for (const f of deleted) await durA.vault.remove(f);
    // (c) strip materializedHash from the base sidecar AND vanish the file: live index entry, never
    // confirmed on disk -> materialized back, NOT a delete candidate, and excluded from the denominator.
    for (let i = 0; i < stripped.length; i++) {
      const basePath = p(`${CONFIG}/zync/base/${strippedIds[i] ?? ""}.json`);
      const raw = await durA.vault.read(basePath);
      if (raw === null) throw new Error("expected a base sidecar");
      const rec = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
      delete rec.materializedHash;
      await durA.vault.writeAtomic(basePath, utf8(JSON.stringify(rec)));
      const f = stripped[i];
      if (f !== undefined) await durA.vault.remove(f);
    }

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);

    // The 6 genuine deletes are a mass wipe of the CONFIRMED population (6 of 8) -> HELD, not propagated.
    for (const f of deleted) {
      expect(a2.engine.index.get(f)?.deleted).not.toBe(true);
      expect(decode(await durA.vault.read(f))).toContain("unique body");
    }
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete").length).toBe(7);
    // The 2 present docs are untouched; the 5 never-materialized docs materialized back, none held.
    for (const f of present) expect(decode(await durA.vault.read(f))).toContain("unique body");
    expect(decode(await durB.vault.read(deleted[0] ?? p("d0.md")))).toContain("unique body");
  });

  it("durable: a NESTED recursive folder delete (scattered sub-subdirs) is held, not auto-propagated", async () => {
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const durB = newDurable(true);
    const files = ["proj/sub1/a.md", "proj/sub2/b.md", "proj/sub3/c.md"].map(p);
    for (const f of files) await durA.vault.writeAtomic(f, utf8(`unique body of ${f}`));
    const a = makeEngine(bus, durA, "device-a");
    const b = makeEngine(bus, durB, "device-b");
    open.push(a.engine, b.engine);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    await a.engine.stop();
    open.length = 0;
    for (const f of files) await durA.vault.remove(f);

    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b.engine);
    await a2.engine.start();
    await converge(a2, b);

    // Different immediate parents (proj/sub1, proj/sub2, proj/sub3) but a shared ANCESTOR "proj" -> held.
    for (const f of files) {
      expect(a2.engine.index.get(f)?.deleted).not.toBe(true);
      expect(decode(await durA.vault.read(f))).toContain("unique body");
    }
    expect(a2.engine.inbox.list().filter((e) => e.kind === "pending-delete").length).toBe(3);
  });

  it("bootstrap prunes a first-seen dirty-orphan (dirty docId with no live entry and no snapshot)", async () => {
    // A SIGKILL in the bumpStamp debounce window can leave a freshly-minted docId marked dirty BEFORE its
    // index entry (and snapshot) became durable. With no live binding and no snapshot, catch-up can never
    // reach it and there is nothing to push — yet pendingDocs counts the dirty id, wedging waitConverged
    // forever (the file itself re-seeds under a fresh docId, so no data is lost). Bootstrap must prune it.
    const bus = new InProcessBus();
    const durA = newDurable(true);
    const ghost = "device-a-1-0" as DocId; // a plausible mintDocId() shape, never bound, no snapshot
    await durA.engineState.markDirty(ghost);

    const a = makeEngine(bus, durA, "device-a");
    open.push(a.engine);
    await a.engine.start();
    await a.engine.waitConverged();

    expect(await durA.engineState.listDirty()).not.toContain(ghost); // pruned from the durable dirty set
    expect(await a.engine.pendingDocs()).not.toContain(ghost); // and no longer wedges quiescence
  });
});
