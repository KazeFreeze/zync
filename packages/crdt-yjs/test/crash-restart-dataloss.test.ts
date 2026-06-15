import { describe, it, expect, afterEach } from "vitest";
import {
  SyncEngine,
  sha256OfText,
  stampHash,
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

/**
 * CRASH-WINDOW DATA-LOSS reproduction (0b-3, the residual crash-device.test.ts gate).
 *
 * THE BUG (root-caused by a cross-model review): a LOCAL edit ingested into a device's
 * dirty-set while PARTITIONED, then SIGKILL'd before the relay acked it, is SILENTLY
 * REVERTED to pristine on restart+reconnect — AND never re-pushed. Mechanism:
 *
 *   1. Local ingest persists the EDITED content as the merge base + marks the doc dirty,
 *      but (for an already-attached doc) does NOT persist the edited CRDT snapshot.
 *   2. After SIGKILL+restart the engine reloads a PRISTINE/stale note doc (the docStore
 *      snapshot is pre-edit; the relay re-pushes its last-acked pristine content), while
 *      DISK and the (working) BASE both still hold the EDITED content.
 *   3. `reconcileDirtyDoc` computes `merge3(base=EDIT, disk=EDIT, crdt=PRISTINE)`.
 *   4. Because disk == base (both EDIT), the merge sees ONLY the CRDT/pristine side as
 *      "changed" → PRISTINE wins → it writes PRISTINE over the disk edit. DATA LOSS.
 *   5. dirty clears vacuously (no update was actually pushed; the doc converged to pristine).
 *
 * This test models the DURABLE-RESTART boundary directly (the durable stores survive; the
 * in-memory doc + relay regress to pristine), then drives the dirty reconcile + catch-up and
 * asserts the edit is RECOVERED + pushed, never clobbered, and dirty retires only after a
 * relay ack for the EDIT's content. Deterministic — no sleeps.
 */

const p = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const CONFIG = ".obsidian";
const NOTE = p("notes/alpha.md");
const PRISTINE = "STATUS: pristine\n\nEnd of alpha.";
const EDIT = `${PRISTINE}\nEdited on A inside the crash window (must survive SIGKILL).`;

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

/**
 * One device's DURABLE storage layer — the part that survives a SIGKILL on a named volume.
 * Reused across two engine lifecycles to model restart: the vault (disk + base records),
 * the docStore (CRDT snapshots), and the engine-state (synced stamps + dirty set) all persist;
 * only the in-memory CRDT docs + the transport/relay are recreated.
 */
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
    identity: identity(deviceId, deviceId),
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

describe("crash-window data-loss: a dirty un-acked offline edit survives SIGKILL+restart (0b-3)", () => {
  it("the disk edit is RECOVERED + re-pushed, never reverted to pristine, and dirty retires only after an ack for the EDIT", async () => {
    const bus = new InProcessBus();
    const durA = newDurable();
    const durB = newDurable();

    // ── Phase 1: A & B converge on the PRISTINE seed (the last-acked state). ──────────
    await durA.vault.writeAtomic(NOTE, utf8(PRISTINE));
    const a1 = makeEngine(bus, durA, "device-a");
    const b1 = makeEngine(bus, durB, "device-b");
    open.push(a1.engine, b1.engine);
    await a1.engine.start();
    await b1.engine.start();
    await a1.engine.waitConverged();
    await b1.engine.waitConverged();
    await a1.engine.waitConverged();
    await b1.engine.waitConverged();
    expect(decode((await durB.vault.read(NOTE)) ?? new Uint8Array())).toBe(PRISTINE);

    const entry = a1.engine.index.get(NOTE);
    if (entry === undefined) throw new Error("expected a live index entry for the note");
    const docId: DocId = entry.docId;
    const pristineHash = await sha256OfText(PRISTINE);
    const editHash = await sha256OfText(EDIT);

    // Capture the PRISTINE note-doc snapshot that is on the durable docStore at this point
    // (shared Yjs history with B). This is the snapshot that SURVIVES the crash — the engine
    // never re-snapshotted the edited attached doc, so the durable docStore stays pristine.
    const pristineSnapshot = await durA.docStore.load(docId);
    if (pristineSnapshot === null) throw new Error("expected a pristine docStore snapshot");

    // ── Phase 2: take A offline, make a LOCAL edit, ingest it (dirty, un-acked). ──────
    a1.transport.goOffline();
    await durA.vault.writeAtomic(NOTE, utf8(EDIT));
    await a1.engine.whenIdle(); // the watcher ingests the edit into the dirty-set offline.

    // The edit is on durable disk and the doc is dirty — there IS un-acked work to lose.
    expect(decode((await durA.vault.read(NOTE)) ?? new Uint8Array())).toBe(EDIT);
    expect(await durA.engineState.listDirty()).toContain(docId);

    // ── Phase 3: SIMULATE SIGKILL + restart on the durable boundary. ─────────────────
    // A SIGKILL leaves whatever the durable volume holds. Crucially, the in-memory CRDT
    // doc + relay state regress: the engine had not persisted the EDITED note-doc snapshot
    // for the already-attached doc, so the docStore snapshot is PRISTINE — on restart the
    // doc reloads pristine, and the relay (last-acked) re-pushes pristine into it.
    // We model that regression EXPLICITLY by destroying the engine and reseeding the
    // docStore snapshot to the pristine content (the pre-edit snapshot that survived).
    await a1.engine.stop();
    open.length = 0; // a1 is stopped; b1 will be re-pushed via the new A engine's bus

    // The durable disk still has the EDIT (named volume). Confirm.
    expect(decode((await durA.vault.read(NOTE)) ?? new Uint8Array())).toBe(EDIT);
    // The dirty flag persisted across the crash (engine-state on the durable volume).
    expect(await durA.engineState.listDirty()).toContain(docId);

    // Force the post-restart bad state per the root cause: the persisted note-doc snapshot
    // is PRISTINE (the engine never re-snapshotted the edited attached doc at ingest time),
    // so on restart the doc reloads PRISTINE — sharing Yjs history with B's pristine doc, so
    // the relay re-sync brings nothing new (a clean revert, exactly as the harness captured).
    await durA.docStore.save(docId, pristineSnapshot);

    // ── Phase 4: restart A's engine over the SAME durable stores; it boots offline, then
    //    heals + re-runs catch-up (the daemon's /sync/start + heal sequence). ──────────
    const a2 = makeEngine(bus, durA, "device-a");
    open.push(a2.engine, b1.engine);
    await a2.engine.start();

    // Right after restart (before reconnect) the durable disk edit is intact.
    expect(decode((await durA.vault.read(NOTE)) ?? new Uint8Array())).toBe(EDIT);

    // Heal (reconnect) and converge. The DESIRED outcome: A re-pushes the un-acked edit;
    // it never gets reverted to pristine; B materializes it.
    a2.transport.goOnline();
    for (let i = 0; i < 30; i++) {
      await a2.engine.waitConverged();
      await b1.engine.waitConverged();
      const pa = await a2.engine.pendingDocs();
      const pb = await b1.engine.pendingDocs();
      if (pa.length === 0 && pb.length === 0) break;
    }

    // ── ASSERTIONS: the edit SURVIVED on A, PROPAGATED to B, and dirty retired only for
    //    the EDIT's content (never vacuously for pristine). ────────────────────────────
    expect(decode((await durA.vault.read(NOTE)) ?? new Uint8Array())).toBe(EDIT); // NOT reverted
    expect(decode((await durB.vault.read(NOTE)) ?? new Uint8Array())).toBe(EDIT); // reached B

    // A's persisted synced stamp ends at the EDIT hash, NOT the pristine hash.
    const syncedA = await durA.engineState.getSyncedStamp(docId);
    expect(syncedA).not.toBeNull();
    expect(stampHash(syncedA ?? "")).toBe(editHash);
    expect(stampHash(syncedA ?? "")).not.toBe(pristineHash);

    // The dirty obligation is retired (the EDIT genuinely acked over the bus).
    expect(await durA.engineState.listDirty()).not.toContain(docId);

    // A & B agree on the note's content hash.
    const treeA = a2.engine.index.get(NOTE)?.stamp;
    const treeB = b1.engine.index.get(NOTE)?.stamp;
    expect(stampHash(treeA ?? "")).toBe(editHash);
    expect(stampHash(treeB ?? "")).toBe(editHash);
  });
});
