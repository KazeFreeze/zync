import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig, INDEX_DOC_ID } from "@zync/core";
import type { CrdtDoc, DeviceId, DocId, IdentityPort, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
  SimulatedEditor,
  type InProcessTransport,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

/**
 * Phase 0b-2 §15 integration suite (PART 1) — TEST-ONLY against the CURRENT
 * committed `SyncEngine`. No engine wiring is touched here. Every scenario
 * settles via engine promises ONLY (`waitConverged`/`whenIdle`/`pendingDocs`) —
 * NEVER `setTimeout` polling — so a runaway relay loop fails FAST as a 15s
 * timeout / heap cap rather than hanging.
 *
 * Offline edits enter the ALREADY-ATTACHED CRDT: every scenario `converge()`s
 * once up-front so the shared doc is attached on both devices BEFORE going
 * offline; only then do offline disk edits flow through the attached Y.Text.
 */

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
  /** KEPT so a test can drive goOffline()/goOnline()/partition()/heal(). */
  transport: InProcessTransport;
}

function makeDevice(bus: InProcessBus, deviceId: string, name: string): Device {
  const vault = new FakeVault();
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport,
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
  return { engine: new SyncEngine(ports, config), vault, transport };
}

/** Persistent ports that SURVIVE an engine restart (model the plugin's on-disk vault + IDB). */
interface Persist {
  vault: FakeVault;
  docStore: FakeDocStore;
  clock: FakeClock;
  engineState: MemEngineState;
}
function makePersist(): Persist {
  return {
    vault: new FakeVault(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    engineState: new MemEngineState(),
  };
}
/** Build a fresh engine over PERSISTENT stores + a NEW bus transport — a "plugin reload". */
function engineOver(bus: InProcessBus, deviceId: string, name: string, p: Persist): Device {
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault: p.vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore: p.docStore,
    clock: p.clock,
    identity: identity(deviceId, name),
    engineState: p.engineState,
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault: p.vault, transport };
}

/** Read a note from a device's vault as text (or null if absent). */
async function readNote(d: Device, p: VaultPath): Promise<string | null> {
  const bytes = await d.vault.read(p);
  return bytes === null ? null : decode(bytes);
}

/**
 * Open a note in an editor exactly as `ObsidianEditorBinding` does: bind the authority FIRST
 * (active-bound), THEN attach, then wrap a SimulatedEditor around the attached doc. Edits via the
 * returned editor carry origin "local-editor" — the live-typing path the GUI #3 report exercises.
 */
async function openEditor(d: Device, p: VaultPath, paneId: string): Promise<SimulatedEditor> {
  const authority = d.engine.getAuthority(p);
  authority.bindEditor(paneId); // MUST precede ensureNoteAttached (only active-bound paths attach)
  const doc: CrdtDoc | undefined = await d.engine.ensureNoteAttached(p);
  if (doc === undefined) throw new Error(`openEditor: ${p} did not attach`);
  return new SimulatedEditor(doc, authority, paneId);
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

describe("SyncEngine §15 integration (deterministic — engine promises only)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  // ── Scenario 1 ────────────────────────────────────────────────────────────
  it("1) offline-both-sides → heal → converge keeps disjoint edits, ZERO artifacts", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A & B converge on a 3-line note (doc attaches on both).
    await a.vault.writeAtomic(A_MD, utf8("line1\nline2\nline3"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("line1\nline2\nline3");

    // Both sides go offline.
    a.transport.goOffline();
    b.transport.goOffline();

    // DISJOINT offline edits: A rewrites line 1, B rewrites line 3.
    // NOTE: we deliberately do NOT call waitConverged() while a device's own
    // transport is offline — catch-up would attach the doc and stall forever on
    // `synced()` (which only resolves after a state-vector exchange the offline
    // transport cannot perform). Offline disk writes are captured by the vault
    // subscription and reconciled once the device is back online.
    await a.vault.writeAtomic(A_MD, utf8("A-EDIT\nline2\nline3"));
    await b.vault.writeAtomic(A_MD, utf8("line1\nline2\nB-EDIT"));

    // Heal both and converge.
    a.transport.goOnline();
    b.transport.goOnline();
    await converge(a, b);

    // Concurrent disjoint edits merge with NO conflict; both edits survive.
    const merged = "A-EDIT\nline2\nB-EDIT";
    expect(await readNote(a, A_MD)).toBe(merged);
    expect(await readNote(b, A_MD)).toBe(merged);
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
    // CRDT merged disjoint lines → no conflict artifact on either inbox.
    expect(a.engine.inbox.list()).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);
  });

  // ── Scenario 2 ────────────────────────────────────────────────────────────
  // ASYMMETRIC offline-origin propagation (Part-2 fix). A & B converge; B goes
  // offline; A (online) edits a disjoint line and self-reconciles; an external
  // writer edits B's disk on a DIFFERENT disjoint line (ingested into B's attached
  // CRDT while offline); B reconnects. The three-way merge must reach BOTH vaults —
  // including A pulling B's offline-origin edit — with zero conflict artifacts.
  it("2) external-edit-during-disconnect → three-way golden merge keeps both sides", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    await a.vault.writeAtomic(A_MD, utf8("line1\nline2\nline3"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("line1\nline2\nline3");

    // B partitions away.
    b.transport.goOffline();

    // A (online) rewrites line 1 and self-reconciles.
    await a.vault.writeAtomic(A_MD, utf8("A-EDIT\nline2\nline3"));
    await a.engine.waitConverged();

    // An EXTERNAL writer rewrites line 3 on B's disk while B is offline. Settle
    // B's ingest into its (offline) CRDT before reconnecting — modeling reality,
    // where the watcher ingests a disk edit long before the network returns.
    // whenIdle() is safe offline: catch-up is a no-op while disconnected.
    await b.vault.writeAtomic(A_MD, utf8("line1\nline2\nB-EXTERNAL"));
    await b.engine.whenIdle();

    // Heal B and converge.
    b.transport.goOnline();
    await converge(a, b);

    // The disjoint three-way merge reaches BOTH vaults — A pulls B's offline edit.
    const merged = "A-EDIT\nline2\nB-EXTERNAL";
    expect(await readNote(b, A_MD)).toBe(merged);
    expect(await readNote(a, A_MD)).toBe(merged);
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
    // Disjoint lines → CRDT merges cleanly → no conflict artifact on either inbox.
    expect(a.engine.inbox.list()).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);
  });

  // ── Scenario 3 ────────────────────────────────────────────────────────────
  it("3) concurrent SAME-line edits (CRDT-write racing ingest) settle deterministically", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    await a.vault.writeAtomic(A_MD, utf8("shared\nmiddle\ntail"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("shared\nmiddle\ntail");

    // BOTH online. Nearly simultaneously each edits the SAME first line — a real
    // conflict that forces the CRDT-write to race each side's local ingest. The
    // only guard against an infinite relay bounce is quiescence; the 15s test
    // timeout + 1GB heap cap would catch a loop, so reaching the asserts proves
    // it settled.
    await a.vault.writeAtomic(A_MD, utf8("A-WINS\nmiddle\ntail"));
    await b.vault.writeAtomic(A_MD, utf8("B-WINS\nmiddle\ntail"));
    await converge(a, b);

    // Quiescence reached on both (no infinite bounce).
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);

    // Both vaults are IDENTICAL and converge to a SINGLE winner (CRDT LWW picks one side). WHICH side
    // wins is RACE-dependent — the two writes + their ingests interleave non-deterministically (the perf
    // history records §15-3's winner flipping when hot-loop timing changed), so we assert convergence to
    // ONE of the two valid winners — never a garbled merge, never a duplicate.
    const finalA = await readNote(a, A_MD);
    const finalB = await readNote(b, A_MD);
    expect(finalA).toBe(finalB);
    expect(["A-WINS\nmiddle\ntail", "B-WINS\nmiddle\ntail"]).toContain(finalA);

    // A genuine same-line conflict was recorded as an artifact on BOTH inboxes
    // (the synced inbox converges the entry to every device).
    expect(a.engine.inbox.list().map((e) => e.path)).toEqual([A_MD]);
    expect(b.engine.inbox.list().map((e) => e.path)).toEqual([A_MD]);

    // Exactly one live index entry for the note (no duplicate doc spawned).
    expect(a.engine.index.liveEntries().map(([p]) => p)).toEqual([A_MD]);
  });

  // ── Scenario 4 ────────────────────────────────────────────────────────────
  it("4) reconnect after a long partition pulls every changed note (catch-up)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // Pre-create several notes BEFORE start so they seed + attach on BOTH sides.
    const names = ["n0.md", "n1.md", "n2.md", "n3.md", "n4.md"].map(path);
    for (const [i, n] of names.entries()) {
      await a.vault.writeAtomic(n, utf8(`note ${String(i)} v1`));
    }
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    for (const n of names) expect(await readNote(b, n)).toMatch(/v1$/);

    // B partitions away; A edits ALL of them while B is offline (a "week offline").
    b.transport.goOffline();
    for (const [i, n] of names.entries()) {
      await a.vault.writeAtomic(n, utf8(`note ${String(i)} v2-EDITED`));
    }
    await a.engine.waitConverged();
    expect(await readNote(b, path("n0.md"))).toMatch(/v1$/); // B saw none of it yet.

    // Reconnect → bounded catch-up pulls ALL changed notes.
    b.transport.goOnline();
    await converge(a, b);
    for (const n of names) {
      expect(await readNote(b, n)).toMatch(/v2-EDITED$/);
      expect(await readNote(a, n)).toBe(await readNote(b, n));
    }
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 5 ────────────────────────────────────────────────────────────
  it("5) sequential adopt of a byte-identical note does NOT double content", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A seeds a.md and fully starts FIRST.
    await a.vault.writeAtomic(A_MD, utf8("identical body"));
    await a.engine.start();
    await a.engine.waitConverged();

    // B has a BYTE-IDENTICAL a.md locally; its index syncs A's entry before bootstrap,
    // so B must ADOPT A's docId — never seed a second one (the doubled-content landmine).
    await b.vault.writeAtomic(A_MD, utf8("identical body"));
    await b.engine.start();
    await converge(a, b);

    const aEntries = a.engine.index.liveEntries().filter(([p]) => p === A_MD);
    const bEntries = b.engine.index.liveEntries().filter(([p]) => p === A_MD);
    expect(aEntries.length).toBe(1);
    expect(bEntries.length).toBe(1);
    const aDocId = aEntries.map(([, e]) => e.docId)[0];
    const bDocId = bEntries.map(([, e]) => e.docId)[0];
    expect(aDocId).toBeDefined();
    expect(aDocId).toBe(bDocId); // same docId — adopted, not re-seeded
    expect(await readNote(b, A_MD)).toBe("identical body");
    expect(b.engine.inbox.list()).toEqual([]); // identical adopt → no conflict artifact
  });

  // ── Scenario 6 ────────────────────────────────────────────────────────────
  it("6) an attached note's edit propagates within the latency budget (sub-ms in-process)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    await a.vault.writeAtomic(A_MD, utf8("v1"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // Note is attached on both. An open-note edit converges (real budget < 150ms LAN;
    // in-process is sub-ms — asserted here as "settles well under the 15s worker cap").
    await a.vault.writeAtomic(A_MD, utf8("v2"));
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("v2");
  });

  // ── Scenario 8 ────────────────────────────────────────────────────────────
  // A note CREATED after start() must materialize into a CRDT and propagate. This
  // is the adopt-pending materialization path (Part 2): the origin device has the
  // content only on disk + base + index stamp until its freshly-attached CRDT is
  // seeded from disk — without that, a peer syncs an empty doc (false quiescence).
  it("8) a note created AFTER start propagates to a peer", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    const NEW = path("created-after-start.md");

    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // A creates a brand-new note AFTER both engines are running.
    await a.vault.writeAtomic(NEW, utf8("hello from A"));
    await converge(a, b);

    expect(await readNote(a, NEW)).toBe("hello from A");
    expect(await readNote(b, NEW)).toBe("hello from A");
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);

    // A follow-up edit to the now-attached note also propagates live.
    await a.vault.writeAtomic(NEW, utf8("hello from A (edited)"));
    await converge(a, b);
    expect(await readNote(b, NEW)).toBe("hello from A (edited)");
  });

  // ── Scenario 7 ────────────────────────────────────────────────────────────
  it("7) offline isolation: an edit is invisible to an offline peer until reconnect", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    await a.vault.writeAtomic(A_MD, utf8("base"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);

    b.transport.goOffline();
    await a.vault.writeAtomic(A_MD, utf8("base + edit"));
    await a.engine.waitConverged();
    expect(await readNote(b, A_MD)).toBe("base"); // offline → still the old content

    b.transport.goOnline();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("base + edit");
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 9 (GUI #3 repro — SHARED docId) ────────────────────────────────
  // The note is OPEN in an editor on BOTH devices (active-bound). A goes offline, types into its
  // editor (CRDT, origin "local-editor"); B types online. On reconnect BOTH edits must survive in
  // BOTH editors. This is the discriminator: if this PASSES, the GUI #3 loss is NOT the core
  // active-bound offline path but the divergent-docId case (Scenario 10).
  it("9) SHARED-docId: an OFFLINE active-bound editor edit survives reconnect (both edits live)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A creates the note; B ADOPTS A's docId (one shared CRDT doc).
    await a.vault.writeAtomic(A_MD, utf8("base"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    const edA = await openEditor(a, A_MD, "pane-a");
    const edB = await openEditor(b, A_MD, "pane-b");
    expect(edA.text()).toBe("base");
    expect(edB.text()).toBe("base");

    // A offline, appends "-A"; B online, prepends "B-". Disjoint positions → clean CRDT merge.
    a.transport.goOffline();
    edA.replaceRange(4, 0, "-A"); // "base" → "base-A"
    edB.replaceRange(0, 0, "B-"); // "base" → "B-base"
    await b.engine.waitConverged();

    a.transport.goOnline();
    await converge(a, b);

    // BOTH edits survive in BOTH live editors (disk is owned by the host autosave while bound, so we
    // assert on the editor/CRDT text — exactly what the user sees on screen).
    expect(edA.text()).toBe("B-base-A");
    expect(edB.text()).toBe("B-base-A");
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 10 (GUI #3 repro — DIVERGENT docIds) ───────────────────────────
  // The identical-vault bootstrap: A and B each INDEPENDENTLY create the same path BEFORE connecting,
  // so each mints its OWN device docId. The index (a CRDT) must converge to ONE docId per path. This
  // pins what happens to an OFFLINE active-bound edit made on the LOSING docId after reconnect.
  it("10) DIVERGENT-docId: independent same-path creates converge; offline active-bound edit survives", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // Each device independently creates a.md with the SAME content but its OWN minted docId.
    await a.vault.writeAtomic(A_MD, utf8("base"));
    await b.vault.writeAtomic(A_MD, utf8("base"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    // The index reconciled to a single live entry on both sides (no duplicate doc).
    expect(a.engine.index.liveEntries().map(([p]) => p)).toEqual([A_MD]);
    expect(b.engine.index.liveEntries().map(([p]) => p)).toEqual([A_MD]);

    const edA = await openEditor(a, A_MD, "pane-a");
    const edB = await openEditor(b, A_MD, "pane-b");

    a.transport.goOffline();
    edA.replaceRange(4, 0, "-A");
    edB.replaceRange(0, 0, "B-");
    await b.engine.waitConverged();

    a.transport.goOnline();
    await converge(a, b);

    // If docIds converged AND the open editor follows the winning doc, both edits survive.
    expect(edA.text()).toBe("B-base-A");
    expect(edB.text()).toBe("B-base-A");
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 12 (cleanup: delete removes the base record, no orphaned state) ─
  it("12) deleting a note removes its base record on BOTH the local and inbound-tombstone paths", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    await a.vault.writeAtomic(A_MD, utf8("to be deleted"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    const docId = a.engine.index.get(A_MD)?.docId;
    if (docId === undefined) throw new Error("note has no index entry after converge");
    const basePath = `.obsidian/zync/base/${docId}.json` as VaultPath;
    // Both devices hold a base record for the live note.
    expect(await a.vault.read(basePath)).not.toBeNull();
    expect(await b.vault.read(basePath)).not.toBeNull();

    // A deletes the note; the tombstone propagates to B (which removes its local file).
    await a.vault.remove(A_MD);
    await converge(a, b);

    expect(await readNote(a, A_MD)).toBeNull();
    expect(await readNote(b, A_MD)).toBeNull();
    // The base record is cleaned up on BOTH sides — A via the local onDelete path, B via the
    // inbound-tombstone path (structural reconcile). No orphaned <docId>.json left behind.
    expect(await a.vault.read(basePath)).toBeNull();
    expect(await b.vault.read(basePath)).toBeNull();
  });

  // ── Scenario 11 (GUI #3 ACTUAL repro — plugin-disabled offline edit) ─────────
  // The real flow the user hit: Vault A DISABLES the plugin (engine.stop), the user types into the
  // still-open note — a plain host write to DISK with NO ingest (the watcher is gone, so no "modify"
  // event ever fires) — while Vault B edits the same note ONLINE; then A RE-ENABLES the plugin
  // (a cold engine restart over the SAME on-disk vault + persisted IDB). A's out-of-band disk edit
  // must MERGE with B's online edit, not be discarded. The persisted stores survive the restart.
  it("11) plugin-disabled offline edit: out-of-band disk edit MERGES on restart (not discarded)", async () => {
    const bus = new InProcessBus();
    const pa = makePersist();
    b = makeDevice(bus, "dev-b", "Device B");

    // Initial converge: A & B agree on a 3-line note.
    await pa.vault.writeAtomic(A_MD, utf8("L1\nL2\nL3"));
    a = engineOver(bus, "dev-a", "Device A", pa);
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("L1\nL2\nL3");

    // A "disables the plugin": stop the engine. Then the user types into the open note → a plain
    // host write straight to disk (no engine running → no ingest, no index bump). Edits line 1.
    await a.engine.stop();
    await pa.vault.writeAtomic(A_MD, utf8("A1\nL2\nL3"));

    // Meanwhile B edits a DISJOINT line ONLINE (via disk → ingest, modelling the host autosave) →
    // relay holds B's edit + the index stamp advances.
    await b.vault.writeAtomic(A_MD, utf8("L1\nL2\nB3"));
    await b.engine.waitConverged();

    // A "re-enables the plugin": a COLD restart over the same on-disk vault + persisted IDB.
    a = engineOver(bus, "dev-a", "Device A", pa);
    await a.engine.start();
    await converge(a, b);

    // A's offline disk edit MUST survive the restart, merged with B's disjoint online edit — NOT
    // discarded (the GUI #3 silent loss: converge would otherwise clobber the un-ingested edit).
    const merged = "A1\nL2\nB3";
    expect(await readNote(a, A_MD)).toBe(merged);
    expect(await readNote(b, A_MD)).toBe(merged);
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 13 (COALESCED observe-driven reconcile — guards the O(n²) fix) ──
  // The catch-up/structural-reconcile/materialize chain is now COALESCED behind the index.observe
  // handler (one pass in flight; mid-pass changes fold into a single re-run) to kill the per-index-
  // change O(n) rescan that made a bulk seed O(n²) on-device. Every other test drives convergence via
  // waitConverged()/flush, which calls that chain DIRECTLY — bypassing the coalescer. This one converges
  // a BURST on the receiver through the OBSERVE PATH ONLY (no waitConverged on B), so it fails if the
  // coalescing ever drops a change (the re-entrant reconcileAgain bug) or stalls.
  it("13) a burst seed converges on a peer via the COALESCED observe path (no waitConverged on B)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    await a.engine.start();
    await b.engine.start();
    await converge(a, b); // both empty + connected

    // A bursts N notes — each push echoes an index change to B, driving B's coalesced observe reconcile.
    const N = 40;
    for (let i = 0; i < N; i++) {
      await a.vault.writeAtomic(
        path(`burst/n${String(i)}.md`),
        utf8(`burst note ${String(i)} body`),
      );
    }
    await a.engine.waitConverged(); // A pushes the whole burst to the relay

    // B converges via the observe handler ONLY — NEVER call waitConverged/flush on B. Pump whenIdle (which
    // awaits B's pending coalesced pass) + yield so the bus can deliver, until all N materialize on B.
    const countMd = async (): Promise<number> =>
      (await b.vault.list()).filter(({ path: p }) => p.startsWith("burst/")).length;
    let have = 0;
    for (let i = 0; i < 200 && have < N; i++) {
      await b.engine.whenIdle();
      have = await countMd();
      if (have < N) await new Promise((r) => setTimeout(r, 2));
    }

    expect(have).toBe(N); // every burst note reached B (no dropped change in the coalescer)
    // Spot-check byte-identity on a sample (no corruption from coalesced materialization).
    for (const i of [0, 17, 39]) {
      const p = path(`burst/n${String(i)}.md`);
      expect(await readNote(b, p)).toBe(`burst note ${String(i)} body`);
    }
    await b.engine.waitConverged();
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 14 (S4c load-bearing: scoped materialize terminal write) ─────────────────────────
  // Guards the S4c `materializeLiveDiskContent(scope)` terminal write (engine.ts ~1162).
  //
  // THE C3 RESURRECTION RACE reproduced DETERMINISTICALLY:
  //
  //   Setup (Phase 1+2): Both A and B converge on a.md; then A deletes it, both converge →
  //   B has a TOMBSTONED index entry, an ATTACHED note-doc (with old "original" text), and
  //   NO file on disk (structural reconcile removed it via C1 delete).
  //
  //   Race (Phase 3): The INDEX is partitioned on B so no index updates reach B yet.
  //   A's note-doc is directly updated to "resurrected content" (via applyEdits, bypassing
  //   ingest so no ingest-merge conflict from the deleted base). The update broadcasts to B
  //   immediately (note-doc not partitioned). B receives it with "remote" origin. B's
  //   `bindOutbound` subscription fires; `pathOf(docId)` returns `undefined` (entry is
  //   TOMBSTONED on B) → `outbound.onRemoteUpdate` early-returns → NO FILE WRITTEN on B.
  //   Now A writes "resurrected content" to its vault: ingest sees disk == crdt == content,
  //   so merge3("" [deleted base], "resurrected content", "resurrected content") is a CLEAN
  //   merge (excludeFalseConflicts) → no CRDT change → no additional broadcast → but the
  //   index IS bumped to hash("resurrected content").
  //
  //   Scoped materialize (Phase 4): B's INDEX partition is healed → A_MD's entry goes LIVE
  //   with the new stamp. The index.observe callback fires synchronously, adds A_MD to
  //   pendingChangedPaths, and calls scheduleReconcile(). whenIdle() awaits the tracked
  //   reconcile loop. Inside it:
  //     buildWorksetWithMaps({A_MD}) → workset={docId}, liveByDocId={docId→[A_MD]}
  //     runObserveScopedReconcile → structuralReconcile(scope) →
  //     materializeLiveDiskContent(scope): entry live, doc attached, docStamp==entry.stamp,
  //     bytes===null → WRITE branch → outbound.onRemoteUpdate(doc) → file appears on B.
  //
  //   This is the ONLY write path that can produce a.md on B after Phase 2 — the direct
  //   `doc.onUpdate` path was skipped (pathOf=undefined at the time), and
  //   `runFullConvergencePass` (waitConverged) has NOT been called on B since Phase 2.
  it("14) C3 resurrection race: scoped materializeLiveDiskContent writes the file via the observe path", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // ── Phase 1: establish initial state ──────────────────────────────────────────────────────
    // A seeds a.md; both start and fully converge so the note-doc is attached on B,
    // B has a live index entry, and B has the file on disk.
    await a.vault.writeAtomic(A_MD, utf8("original content"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("original content");
    const docId = b.engine.index.get(A_MD)?.docId;
    expect(docId).toBeDefined();

    // ── Phase 2: delete → full converge → B's index shows tombstone, B's file is gone ────────
    // A deletes a.md; converge drives B's structural reconcile which removes the file (C1) and
    // leaves B's index with a tombstone for A_MD. The note-doc STAYS attached on both sides
    // (deletion only tombstones the index entry and removes the vault file, never detaches docs).
    await a.vault.remove(A_MD);
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBeNull(); // C1 delete propagated: B's file gone
    expect(b.engine.index.get(A_MD)?.deleted).toBe(true); // tombstone on B

    // ── Phase 3: the C3 race — note-doc update arrives while entry is tombstoned ─────────────
    // Partition INDEX_DOC on B so B cannot receive index changes yet.
    b.transport.partition(INDEX_DOC_ID);

    // Directly apply an edit to A's note-doc with "local-editor" origin (bypassing ingest so
    // we avoid the merge3 conflict that arises from the deleted base record). The in-process
    // bus broadcasts it to B immediately. On B:
    //   - origin is "remote" → bindOutbound subscription fires
    //   - pathOf(docId) returns `undefined` (A_MD is TOMBSTONED on B's index)
    //   - outbound.onRemoteUpdate(doc) is called but early-returns (pathOf undefined)
    //   → NO FILE IS WRITTEN on B (this is the race we are closing)
    const noteDocOnA = a.engine.getAttachedDoc(A_MD);
    // getAttachedDoc resolves via the tombstoned index entry (index.get returns tombstones too).
    if (noteDocOnA === undefined) throw new Error("scenario 14: note-doc was not attached on A");
    const RESURRECTED = "resurrected content";
    // Apply edit: replaces "original content" with "resurrected content" in A's note-doc.
    noteDocOnA.applyEdits(
      [{ at: 0, delete: "original content".length, insert: RESURRECTED }],
      "local-editor",
    );
    expect(noteDocOnA.getText()).toBe(RESURRECTED); // A's CRDT updated

    // Drain B's engine: the broadcast arrived, bindOutbound skipped the write (pathOf=undefined).
    // The tracked onRemoteUpdate resolves trivially.
    await b.engine.whenIdle();
    // CRITICAL PROOF: the direct write was skipped — B still has NO file.
    expect(await readNote(b, A_MD)).toBeNull();
    // B's note-doc now carries "resurrected content" (CRDT applied).
    expect(b.engine.getAttachedDoc(A_MD)?.getText()).toBe(RESURRECTED);

    // Now write "resurrected content" to A's vault so A's ingest resurrects the index entry.
    // A's base was deleted by onDelete, so merge3("" [empty], "resurrected", "resurrected") is
    // a CLEAN merge (disk == crdt, excludeFalseConflicts → no false conflict). No CRDT update
    // fires (content already matches), so no additional broadcast to B. The index IS bumped.
    await a.vault.writeAtomic(A_MD, utf8(RESURRECTED));
    await a.engine.waitConverged(); // A processes the write: index goes LIVE with new stamp

    // INDEX is still partitioned on B → A_MD still tombstoned on B.
    expect(b.engine.index.get(A_MD)?.deleted).toBe(true);
    // Still no file on B.
    expect(await readNote(b, A_MD)).toBeNull();

    // ── Phase 4: heal INDEX → observe path triggers scoped materialize ────────────────────────
    // Healing delivers the index update to B: A_MD's entry goes LIVE with the new stamp.
    // The index.observe callback fires synchronously:
    //   pendingChangedPaths.add(A_MD) → scheduleReconcile() → queueMicrotask(runReconcileLoop)
    // The loop promise is TRACKED so whenIdle() waits for it.
    b.transport.heal(INDEX_DOC_ID);
    // Index state-vector exchange is synchronous — B's index now has A_MD LIVE.
    expect(b.engine.index.get(A_MD)?.deleted).not.toBe(true);

    // whenIdle() awaits the tracked reconcile loop. Inside the loop:
    //   buildWorksetWithMaps({A_MD}) → workset={docId}, liveByDocId={docId→[A_MD]}
    //   runObserveScopedReconcile(bundle):
    //     runCatchUp (scoped, reuses existing attached doc, advances syncedStamp)
    //     structuralReconcile(scope) → materializeLiveDiskContent(scope):
    //       entry is LIVE, doc is ATTACHED, docStamp==entry.stamp, bytes===null → WRITE
    //       outbound.onRemoteUpdate(doc) → writes "resurrected content" to B's vault
    // This is the ONLY code path that can produce a.md on B at this point.
    await b.engine.whenIdle();

    // ── Assert: the file appeared on B via the SCOPED materialize terminal write ───────────────
    expect(await readNote(b, A_MD)).toBe(RESURRECTED);
  });

  // ── Scenario 15 (S5 load-bearing: scoped-rename-closure via allByDocId expansion) ───────────
  // Guards the S5 `allByDocId` closure expansion in `runStructuralReconcile`.
  //
  // A renames old.md → new.md while B's INDEX is partitioned. When B's INDEX is healed,
  // the OBSERVE path fires for BOTH old.md (now tombstoned) AND new.md (now live). The scoped
  // rename loop must visit old.md's tombstone — which requires iterating `allByDocId[docId]`
  // (live + tombstoned sibling paths), NOT just `liveByDocId[docId]` (live only).
  //
  // If the scope only iterates live paths, old.md's tombstone is never visited by the rename
  // concern, old.md stays on B's disk forever (delete concern skips it because docId is live
  // elsewhere), and the test FAILS — proving the break.
  it("15) S5 scoped-rename-closure: old-key tombstone reachable via allByDocId expansion (observe only)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    const OLD_MD = path("old.md");
    const NEW_MD = path("new.md");

    // ── Phase 1: establish initial state ─────────────────────────────────────────────────────
    // A seeds old.md; both start and fully converge so B has old.md on disk + in the index.
    await a.vault.writeAtomic(OLD_MD, utf8("carry me across"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, OLD_MD)).toBe("carry me across");
    expect(b.engine.index.get(OLD_MD)?.deleted).not.toBe(true); // live on B

    // ── Phase 2: partition INDEX on B, rename old.md → new.md on A ───────────────────────────
    // B cannot receive A's index changes yet. A renames old.md → new.md: A's index gets a
    // tombstone for old.md and a live entry for new.md (same docId — content continuity).
    b.transport.partition(INDEX_DOC_ID);
    await a.vault.rename(OLD_MD, NEW_MD); // vault.rename fires the rename event on A's engine
    await a.engine.whenIdle(); // A processes the rename: index re-keyed
    expect(await readNote(a, NEW_MD)).toBe("carry me across"); // A has new.md on disk
    expect(await readNote(a, OLD_MD)).toBeNull(); // A's old.md is gone

    // B still has old.md (index partition blocks the update).
    expect(await readNote(b, OLD_MD)).toBe("carry me across");
    expect(await readNote(b, NEW_MD)).toBeNull();

    // ── Phase 3: heal INDEX → observe path fires on B ─────────────────────────────────────────
    // Healing delivers A's pending index changes to B: old.md's tombstone AND new.md's live
    // entry. Both are in B's pendingChangedPaths. buildWorksetWithMaps resolves docId from
    // both paths; allByDocId[docId] = [old.md, new.md].
    //
    // S5 scoped rename loop: iterates allByDocId[docId] = [old.md, new.md].
    //   - old.md: entry is tombstoned, liveByDocId[docId] = [new.md] (FULL) → emptyTarget =
    //     new.md (no file there yet on B) → vault.rename(old.md, new.md)
    //   - new.md: entry is live (deleted !== true) → skip
    //
    // WITHOUT the allByDocId expansion (broken: only live paths), scopedPaths = [new.md].
    // new.md is live → skip. old.md is never visited. old.md stays on disk forever.
    b.transport.heal(INDEX_DOC_ID);
    // Index state-vector exchange is synchronous — B's index now has old.md tombstoned, new.md live.
    expect(b.engine.index.get(OLD_MD)?.deleted).toBe(true);
    expect(b.engine.index.get(NEW_MD)?.deleted).not.toBe(true);

    // whenIdle() awaits the tracked reconcile loop driven by the observe callback.
    // Inside: runObserveScopedReconcile → structuralReconcile(scope) →
    //   runStructuralReconcile(scope) → rename loop visits old.md → vault.rename(old.md, new.md)
    // This is the ONLY code path that can move old.md to new.md on B at this point.
    await b.engine.whenIdle();

    // ── Assert: the rename propagated via the SCOPED structural reconcile ─────────────────────
    expect(await readNote(b, NEW_MD)).toBe("carry me across"); // renamed file at new path
    expect(await readNote(b, OLD_MD)).toBeNull(); // old file gone (moved)
  });

  // ── Scenario 16 (S6a load-bearing: divergent-rename self-draining via freshBackstopWork) ────
  // Guards the S6a liveness property for the divergent-rename / stability-gate flow:
  //   1. The first post-heal observe pass records the divergence into pendingDivergenceDocIds
  //      (stability gate: confirmDivergence returns false — second sighting not yet seen).
  //   2. S6a: enqueuePendingDivergenceDocId fires freshBackstopWork=true + scheduleReconcile,
  //      so the reconcile loop immediately runs a SECOND backstop-only pass WITHOUT any
  //      unrelated index event. This second pass confirms the divergence (priorDivergence
  //      signature matches) and resolves it (x.md wins lex, y.md tombstoned).
  //   3. The tombstone-index write from the resolution fires index.observe → a THIRD pass runs,
  //      draining pendingDivergenceDocIds (docId now has ≤1 live path).
  //
  // After a single whenIdle() following goOnline(), the ENTIRE convergence sequence completes
  // WITHOUT any unrelated follow-up write. That is the S6a liveness property being tested.
  //
  // Break experiment: removing the pendingDivergenceDocIds union from buildWorksetWithMaps
  // makes the SECOND backstop-only pass ignore the divergent docId → never confirmed →
  // never resolved → the divergence stays open and the assertions below FAIL.
  // (Without S6a entirely, the second pass never auto-runs and the divergence also never
  // resolves without an unrelated write — the original stall scenario.)
  it("16) S6a divergent-rename self-draining: resolves WITHOUT unrelated follow-up write", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    const X_MD = path("x.md");
    const Y_MD = path("y.md");

    // ── Phase 1: establish initial state ─────────────────────────────────────────────────────
    // A seeds a.md; both start and fully converge. docId is stable on both sides.
    await a.vault.writeAtomic(A_MD, utf8("divergent body"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("divergent body");
    const docIdRaw = b.engine.index.get(A_MD)?.docId;
    if (docIdRaw === undefined) throw new Error("scenario 16: docId not found for a.md");
    const docId: DocId = docIdRaw;

    // ── Phase 2: both sides rename offline ────────────────────────────────────────────────────
    // B goes offline. A renames a.md → x.md. B renames a.md → y.md.
    // After reconnect: docId is live at BOTH x.md (from A) AND y.md (from B) → DIVERGENCE.
    b.transport.goOffline();

    await a.vault.rename(A_MD, X_MD); // A: a.md tombstoned, x.md live
    await a.engine.whenIdle(); // A processes its rename

    await b.vault.rename(A_MD, Y_MD); // B: a.md tombstoned, y.md live (local, no index sync yet)
    await b.engine.whenIdle(); // B processes its own rename (y.md live, a.md tombstoned on B)

    // B now has y.md on disk; x.md is not yet known to B.
    expect(await readNote(b, Y_MD)).toBe("divergent body");
    expect(await readNote(b, X_MD)).toBeNull();

    // ── Phase 3: reconnect B → S6a self-draining resolves divergence WITHOUT a follow-up write ─
    // goOnline() triggers resyncAll() synchronously: B receives A's index state (x.md live).
    // B's index now has: a.md=tombstoned, y.md=live, x.md=live → docId at 2 live paths.
    // The index.observe callback fires → scheduleReconcile → first observe pass:
    //   - confirmDivergence: priorDivergence empty → NOT confirmed (first sighting)
    //   - enqueuePendingDivergenceDocId: docId is NEW → freshBackstopWork=true (already in
    //     the running loop; the flag will be checked at the top of the NEXT iteration)
    // Loop continues: freshBackstopWork=true → second (backstop-only) pass:
    //   - workset = pendingDivergenceDocIds = {docId}
    //   - confirmDivergence: priorDivergence.get(docId) === sig → CONFIRMED
    //   - applyRenameConflictResolution: x.md < y.md lex → x.md wins, y.md tombstoned
    //   - resolution fires index.observe → pendingChangedPaths += {y.md}
    // Loop continues: pendingChangedPaths = {y.md} → third pass drains pendingDivergenceDocIds.
    b.transport.goOnline();
    // S6a: ALL THREE passes complete within whenIdle() — no unrelated write needed.
    await b.engine.whenIdle();

    // Assert: divergence FULLY RESOLVED via S6a self-draining (no unrelated write triggered).
    expect(b.engine.index.get(X_MD)?.deleted).not.toBe(true); // x.md still live (winner)
    expect(b.engine.index.get(Y_MD)?.deleted).toBe(true); // y.md tombstoned (loser)
    // pendingDivergenceDocIds is drained (third pass saw docId with ≤1 live path).
    expect(b.engine.pendingDivergenceDocIdsSnapshot().has(docId)).toBe(false);

    // Full convergence (waitConverged) to materialize x.md on disk + remove y.md.
    await b.engine.waitConverged();
    expect(await readNote(b, X_MD)).toBe("divergent body"); // content preserved at winning path
    expect(await readNote(b, Y_MD)).toBeNull(); // loser's file removed
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 17 (S6b load-bearing: clean-settle-latch via scoped settleCleanDocs) ─────────────
  // Guards the S6b scoped `settleCleanDocs` for the clean-settle-latch case:
  // a doc converges via a REMOTE NOTE-DOC UPDATE with NO further index-key change.
  //
  // SETUP: A and B converge on a.md. Then a clean disjoint 3-way merge happens:
  //   A applies a remote update to the note-doc directly (bypassing ingest) while B's INDEX
  //   is partitioned. This simulates a doc convergence that arrives via the note-doc CRDT
  //   channel (not via an index-key change). When B heals its index partition, the settled
  //   synced stamp must advance — proving scoped settleCleanDocs visits the doc via the
  //   remoteUpdatedSinceSettle union in the workset.
  //
  // OBSERVE-PATH ONLY: B never calls waitConverged. The settlement must happen via the
  // coalesced observe path (whenIdle). This fails if scoped settleCleanDocs does not
  // include docs from remoteUpdatedSinceSettle in the workset.
  //
  // BREAK EXPERIMENT RESULT: neutering the ENTIRE scoped settle body causes the test to
  // fail on the `remoteUpdatedSinceSettleSnapshot().size === 0` drain assertion — NOT the
  // synced-stamp / pendingDocs assertion. That is because runCatchUp (which runs BEFORE
  // settle in the observe-scoped chain) advances the synced stamp first over the in-process
  // bus; the drain of remoteUpdatedSinceSettle is the remaining observable. To pin the
  // synced-stamp advance itself as load-bearing, Scenario 19 uses a stubbed runCatchUp —
  // see that test for a load-bearing isolator of the CLEAN-SETTLE write specifically.
  it("17) S6b clean-settle-latch (scoped): synced stamp advances via scoped settleCleanDocs on the observe path", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // ── Phase 1: converge on a.md ─────────────────────────────────────────────────────────────
    await a.vault.writeAtomic(A_MD, utf8("base content"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("base content");

    if (b.engine.index.get(A_MD)?.docId === undefined)
      throw new Error("scenario 17: docId not found after converge");

    // ── Phase 2: partition B's INDEX, update the note-doc directly on A ──────────────────────
    // B cannot receive index changes yet. We directly apply an edit to A's note-doc so the
    // note-doc CRDT channel delivers it to B (as a "remote" update). B's bindOutbound fires
    // and enqueues docId into remoteUpdatedSinceSettle. At this point B's index stamp is still
    // "base content" — no index-key change has arrived yet.
    b.transport.partition(INDEX_DOC_ID);

    const noteDocOnA = a.engine.getAttachedDoc(A_MD);
    if (noteDocOnA === undefined) throw new Error("scenario 17: note-doc not attached on A");

    // Apply a disjoint edit — append "-updated" to the end of the text.
    noteDocOnA.applyEdits(
      [{ at: "base content".length, delete: 0, insert: "-updated" }],
      "local-editor",
    );
    expect(noteDocOnA.getText()).toBe("base content-updated");

    // Drain B's tracked reconcile (the note-doc remote update fires bindOutbound on B,
    // which enqueues docId into remoteUpdatedSinceSettle and tracks an outbound pass).
    await b.engine.whenIdle();

    // CRITICAL: docId is now in remoteUpdatedSinceSettle on B.
    // The index is still partitioned so B's index stamp has NOT advanced.
    // scoped settleCleanDocs cannot settle yet (triple-equality fails: docStamp ≠ index stamp).
    const afterRemoteUpdate = b.engine.remoteUpdatedSinceSettleSnapshot();
    // After whenIdle the scoped settle may have already tried and drained it as non-actionable
    // or left it. The KEY test is the post-heal behavior below.
    expect(afterRemoteUpdate.size).toBeLessThanOrEqual(1); // at most docId (may have drained)

    // ── Phase 3: write the updated content to A's vault → ingest → index bump ────────────────
    // A ingests the new content → index entry gets bumped to hash("base content-updated").
    // The note-doc content and index stamp are now aligned on A.
    await a.vault.writeAtomic(A_MD, utf8("base content-updated"));
    await a.engine.waitConverged();

    // ── Phase 4: heal the index partition → scoped settleCleanDocs must settle on B ──────────
    // Healing delivers A's index bump to B: A_MD's stamp advances to hash("base content-updated").
    // The index.observe fires on B → scheduleReconcile → the scoped reconcile loop runs:
    //   buildWorksetWithMaps({A_MD}) → workset = {docId}, including remoteUpdatedSinceSettle
    //   runObserveScopedReconcile → settleCleanDocs(scope):
    //     doc text hash ("base content-updated") == index stamp == disk hash → SETTLE
    //     synced stamp advances to hash("base content-updated") → pendingDocs clears
    b.transport.heal(INDEX_DOC_ID);
    // B's index now has the updated stamp.
    expect(b.engine.index.get(A_MD)?.deleted).not.toBe(true);

    // Await B's tracked reconcile — the scoped settleCleanDocs must advance the synced stamp.
    await b.engine.whenIdle();

    // ── Assert: synced stamp advanced, pendingDocs is empty ──────────────────────────────────
    // B received the note-doc update (text is correct) AND the index stamp advanced via heal.
    // Scoped settleCleanDocs must have advanced the synced stamp — proving it visited the doc
    // via the workset (which includes docId from remoteUpdatedSinceSettle union).
    expect(await readNote(b, A_MD)).toBe("base content-updated");
    // remoteUpdatedSinceSettle is drained (scoped settle advanced the synced stamp).
    expect(b.engine.remoteUpdatedSinceSettleSnapshot().size).toBe(0);
    // The settled synced stamp clears the pending latch — pendingDocs is empty on B.
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 18 (S6b convergence smoke: materialize-race via scoped settleCleanDocs) ──────────
  // Smoke-tests the S6b scoped `settleCleanDocs` for the materialize-race ordering:
  // the live index entry arrives BEFORE the note-doc content; materialize skips (no doc text
  // yet); then the note-doc content arrives with NO further index-key change.
  //
  // SETUP: A and B converge on a.md. Then:
  //   1. B's INDEX partition is healed first (index entry arrives before note-doc content).
  //   2. The note-doc update (the content) arrives on B via the note-doc CRDT channel.
  //   3. No further index change fires on B after step 2.
  //
  // OBSERVE-PATH ONLY: B never calls waitConverged after Phase 1. The doc settles on B
  // via the observe path only. This test exercises convergence in the materialize-race
  // ordering; however, neutering ONLY the scoped CLEAN-SETTLE write (setSyncedStamp + drains
  // at lazy-attach.ts ~843-848) does NOT make this test fail — runCatchUp (which runs before
  // settle in the observe-scoped chain) advances the synced stamp first over the in-process
  // bus. This scenario is retained as an ordering/convergence smoke test; Scenario 19 is the
  // load-bearing isolator for the scoped CLEAN-SETTLE synced-stamp advance specifically.
  it("18) S6b materialize-race (scoped): doc settles on observe path when note update has no further index bump", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // ── Phase 1: converge on a.md ─────────────────────────────────────────────────────────────
    await a.vault.writeAtomic(A_MD, utf8("v1 content"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("v1 content");

    const docIdRaw = b.engine.index.get(A_MD)?.docId;
    if (docIdRaw === undefined) throw new Error("scenario 18: docId not found after converge");

    // ── Phase 2: partition BOTH index and note-doc on B ───────────────────────────────────────
    // Block both the index doc and the note-doc from reaching B.
    b.transport.partition(INDEX_DOC_ID);
    b.transport.partition(docIdRaw);

    // A updates the content (new text) → index bump + note-doc CRDT update both queued.
    await a.vault.writeAtomic(A_MD, utf8("v2 content"));
    await a.engine.waitConverged();

    // B's index and note-doc partitions are both active — B still sees "v1 content".
    expect(await readNote(b, A_MD)).toBe("v1 content");

    // ── Phase 3: heal INDEX first (entry arrives, but note-doc not yet) ───────────────────────
    // Heal only the index — B gets the stamp bump for A_MD.
    // The observe fires on B: buildWorksetWithMaps → workset = {docId}
    //   runObserveScopedReconcile → runCatchUp: tries to settle but the note-doc content
    //   hasn't arrived yet; it can materialize the doc (via the doc store/empty doc) and attach,
    //   but the text is still "v1 content" in the local doc → triple-equality gate fails
    //   (docStamp = hash("v1 content") ≠ index stamp = hash("v2 content")) → not settled yet.
    b.transport.heal(INDEX_DOC_ID);
    await b.engine.whenIdle();

    // At this point B knows about the new index stamp but does not have v2 content yet.
    // The note-doc is attached on B (catch-up ran), but text is still the old value.
    // pendingDocs: docId is pending (synced stamp ≠ index stamp).

    // ── Phase 4: heal note-doc → content arrives → scoped settle must clear it ────────────────
    // Heal the note-doc partition: B receives the v2 CRDT update (remote origin).
    // bindOutbound fires → enqueues docId into remoteUpdatedSinceSettle.
    // onBackstopWork fires → scheduleReconcile → scoped reconcile loop:
    //   workset includes docId (from remoteUpdatedSinceSettle)
    //   settleCleanDocs(scope): doc text hash ("v2 content") == index stamp == disk hash? → SETTLE
    //   (disk is "v1 content" initially; outbound also writes v2 to disk via onRemoteUpdate)
    b.transport.heal(docIdRaw);
    await b.engine.whenIdle();

    // ── Assert: B has v2 content and pendingDocs is empty ────────────────────────────────────
    // The note-doc update was delivered and the settle pass advanced the synced stamp.
    // No further index bump was needed — the scoped settle handled it via remoteUpdatedSinceSettle.
    expect(await readNote(b, A_MD)).toBe("v2 content");
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  // ── Scenario 19 (S6b load-bearing isolator: scoped CLEAN-SETTLE is the ONLY synced-stamp advancer)
  //
  // This is the load-bearing pin for the CLEAN-SETTLE write inside the scoped `settleCleanDocs`
  // branch (`lazy-attach.ts` — the `setSyncedStamp` call and the two `delete` drains that follow).
  //
  // WHY Scenarios 17/18 are NOT load-bearing for the CLEAN-SETTLE synced-stamp advance:
  //   Over the in-process bus, BOTH `runCatchUp` AND `outbound.onRemoteUpdate` (called by
  //   `bindOutbound` when a note-doc CRDT update arrives) advance the synced stamp before settle
  //   runs. So by the time `settleCleanDocs` executes, the stamps are already equal and settle
  //   finds nothing to do. Neutering the CLEAN-SETTLE write in the scoped branch does NOT make
  //   Sc.17's pendingDocs assertion fail; Sc.18 passes entirely even with the whole scoped body
  //   removed.
  //
  // ISOLATION TECHNIQUE (single device, direct settle call on a quiescent engine):
  //   1. Converge a single device fully (doc attached, all stamps aligned, engine quiescent).
  //   2. Manually LATCH the synced stamp to a stale value via the held EngineStateStore ref.
  //   3. Construct the CatchUpScope manually (no noteRemoteUpdate → no scheduleReconcile → no
  //      runCatchUp race) and call settleCleanDocs(scope) DIRECTLY on the manager.
  //   4. The engine is quiescent (waitConverged settled all pending work; no new microtasks were
  //      queued between the latch and the direct call). The ONLY setSyncedStamp that can fire
  //      inside this call is the CLEAN-SETTLE write in the scoped branch.
  //
  // LOAD-BEARING EXPERIMENT (performed, production restored byte-for-byte):
  //   Neutering the CLEAN-SETTLE write (the `setSyncedStamp` call + the two `delete` drains at
  //   `lazy-attach.ts` ~843-848) causes:
  //   - `expect(syncedAfter).not.toBe(STALE_STAMP)` to FAIL (stamp stays "STALE:dev-a")
  //   - `expect(pendingAfter).toEqual([])` to FAIL (doc remains pending)
  //   With production code restored both pass — confirming the CLEAN-SETTLE write is the sole
  //   synced-stamp advancer in this setup and this test is load-bearing.
  it(
    "19) S6b CLEAN-SETTLE isolator: scoped settleCleanDocs is the ONLY synced-stamp advancer (latched stamp + direct settle call)",
    { timeout: 30_000 },
    async () => {
      // ── Setup: single device with held EngineStateStore reference ──────────────────────────
      // Hold the engineState reference so we can manually latch the synced stamp after convergence
      // without needing a relay or peer.
      const bus = new InProcessBus();
      const pa = makePersist();
      a = engineOver(bus, "dev-a", "Device A", pa);
      // b is required by afterEach (stop()). Use a standard inert device.
      b = makeDevice(bus, "dev-b", "Device B");
      await a.engine.start();
      await b.engine.start();

      // ── Phase 1: seed a.md and bring the engine to full quiescence ─────────────────────────
      // After waitConverged, all stamps are aligned: synced stamp == index stamp == doc-text hash
      // == disk hash. Engine is quiescent — no pending inflight promises, no queued microtasks.
      await a.vault.writeAtomic(A_MD, utf8("settle-isolator body"));
      await a.engine.waitConverged();

      expect(await readNote(a, A_MD)).toBe("settle-isolator body");

      const docIdRaw = a.engine.index.get(A_MD)?.docId;
      if (docIdRaw === undefined) throw new Error("scenario 19: docId not found");
      const docId: DocId = docIdRaw;

      expect(await a.engine.pendingDocs()).toEqual([]);

      // Capture the correct index stamp so we can assert the CLEAN-SETTLE write sets it.
      const indexEntry = a.engine.index.get(A_MD);
      if (indexEntry === undefined) throw new Error("scenario 19: index entry missing");
      const correctStamp = indexEntry.stamp;

      // ── Phase 2: MANUALLY LATCH the synced stamp to a stale value ──────────────────────────
      // Simulate the clean-settle latch: doc-text == disk == index stamp, but the synced stamp
      // is stuck at an earlier hash. In production this arises when a doc converges via a remote
      // note-doc update (which advances the CRDT + disk) with no concurrent index-key change —
      // the synced stamp stays at the prior merged hash, causing pendingDocs to falsely report
      // the doc as pending.
      //
      // We write a fake stale stamp via the held EngineStateStore. The string "STALE:dev-a" does
      // not match correctStamp under stampsEqual (different hash part), so settle will enter the
      // triple-equality gate and reach the CLEAN-SETTLE block.
      const STALE_STAMP = "STALE:dev-a" as import("@zync/core").Stamp;
      await pa.engineState.setSyncedStamp(docId, STALE_STAMP);

      // Pre-condition: pendingDocs reports the doc as pending (synced stamp != index stamp).
      const pendingBefore = await a.engine.pendingDocs();
      expect(pendingBefore).toContain(docId);

      // ── Phase 3: build the scope manually and call settleCleanDocs directly ────────────────
      // We construct the CatchUpScope manually instead of using noteRemoteUpdate + buildWorkset.
      // noteRemoteUpdate fires onBackstopWork → scheduleReconcile → queues a microtask to run
      // runReconcileLoop → which calls runCatchUp → which can advance the synced stamp via
      // its own setSyncedStamp path. Constructing the scope manually avoids queuing any
      // microtask, keeping the engine quiescent through the direct settleCleanDocs call.
      //
      // The scope contains docId in the workset and A_MD as its live path — exactly what
      // buildWorksetWithMaps would return for a batch containing A_MD.
      const mgr = a.engine.lazyAttachManager;
      const manualScope = {
        workset: new Set<DocId>([docId]),
        liveByDocId: new Map<DocId, VaultPath[]>([[docId, [A_MD]]]),
      };

      // Direct call: settleCleanDocs with the scoped workset. The engine is quiescent; no
      // runCatchUp or outbound.onRemoteUpdate will run during this call (no pending microtasks,
      // no scheduleReconcile was called). The ONLY setSyncedStamp that can fire is the
      // CLEAN-SETTLE write in the scoped branch.
      await mgr.settleCleanDocs(manualScope);

      // ── Assert: CLEAN-SETTLE write fired — synced stamp advanced ───────────────────────────
      //
      // If the CLEAN-SETTLE write fires (production code):
      //   - synced stamp == correctStamp (advanced from "STALE:dev-a" to the index stamp)
      //   - pendingDocs() is empty (synced now equals index stamp)
      //
      // If the CLEAN-SETTLE write is NEUTERED (setSyncedStamp + drains commented out):
      //   - synced stamp stays "STALE:dev-a" → expect(syncedAfter).not.toBe(STALE_STAMP) FAILS
      //   - pendingDocs still contains docId → expect(pendingAfter).toEqual([]) FAILS
      const syncedAfter = await pa.engineState.getSyncedStamp(docId);
      expect(syncedAfter).not.toBe(STALE_STAMP); // stamp was advanced by the CLEAN-SETTLE write
      expect(syncedAfter).toBe(correctStamp); // advanced to the exact index stamp
      const pendingAfter = await a.engine.pendingDocs();
      expect(pendingAfter).toEqual([]); // synced == index → doc is no longer pending
    },
  );
});
