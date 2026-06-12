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

    // Both vaults are IDENTICAL and the winner is DETERMINISTIC (CRDT LWW picks
    // one side; here the engine consistently lands on the A-authored line).
    const finalA = await readNote(a, A_MD);
    const finalB = await readNote(b, A_MD);
    expect(finalA).toBe(finalB);
    expect(finalA).toBe("A-WINS\nmiddle\ntail");

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
});
