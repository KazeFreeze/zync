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
 * Phase 0b-2 Task 1 — STRUCTURAL RECONCILE (C1): an inbound index TOMBSTONE must
 * become a `vault.remove` on the peer. Before this task, A could tombstone a note
 * (which replicates) but NO engine path turned that inbound tombstone into a
 * removal on B, so B kept the file forever while both engines reported
 * `pendingDocs() === []` (false quiescence).
 *
 * Settles via engine promises ONLY (`converge`/`waitConverged`/`pendingDocs`) —
 * never `setTimeout` polling — so a runaway relay loop fails FAST under the 15s
 * timeout / 1GB heap cap rather than hanging.
 */

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const A_MD = path("a.md");

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
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
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault, transport };
}

async function readNote(d: Device, p: VaultPath): Promise<string | null> {
  const bytes = await d.vault.read(p);
  return bytes === null ? null : decode(bytes);
}

async function converge(a: Device, b: Device): Promise<void> {
  await convergeAll(a, b);
}

/**
 * Drive N devices to a JOINT fixed point. Each round runs every device's
 * `waitConverged` (so cross-device index changes from one device's recovery are
 * pulled + reconciled by the others), then checks all `pendingDocs()` are empty.
 * Bounded so a runaway relay loop fails fast under the suite's 15s timeout.
 */
async function convergeAll(...devices: Device[]): Promise<void> {
  for (let i = 0; i < 20; i++) {
    for (const d of devices) await d.engine.waitConverged();
    let allClear = true;
    for (const d of devices) {
      if ((await d.engine.pendingDocs()).length !== 0) {
        allClear = false;
        break;
      }
    }
    if (allClear) return;
  }
  throw new Error("convergeAll: engines did not reach a joint fixed point");
}

describe("SyncEngine structural reconcile (C1 — inbound tombstone → vault.remove)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("online delete propagates removal to peer", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A & B converge on a note; the doc attaches on both.
    await a.vault.writeAtomic(A_MD, utf8("doomed body"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("doomed body");

    // A deletes the note while BOTH are online → A lays an index tombstone that
    // replicates to B; B's structural reconcile must turn it into a vault.remove.
    await a.vault.remove(A_MD);
    await converge(a, b);

    // The delete propagated to BOTH vaults.
    expect(await readNote(a, A_MD)).toBeNull();
    expect(await readNote(b, A_MD)).toBeNull();

    // No false quiescence: both engines are clean.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);

    // The removal must NOT have spawned a conflict / resurrection / spurious inbox.
    expect(a.engine.inbox.list()).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);
  });

  it("edit-beats-delete: a concurrent offline edit resurrects the note (C3)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A & B converge on a note.
    await a.vault.writeAtomic(A_MD, utf8("original body"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("original body");

    // B partitions away. While offline, A deletes the note (lays a tombstone that
    // CANNOT yet reach B) and self-reconciles; B edits the SAME note offline. After
    // the partition heals, the edit must beat the delete: the note RESURRECTS at
    // B's content on BOTH devices — content is never lost to a delete it raced.
    b.transport.goOffline();

    await a.vault.remove(A_MD);
    await a.engine.whenIdle();
    expect(await readNote(a, A_MD)).toBeNull(); // A's own delete applied locally.

    await b.vault.writeAtomic(A_MD, utf8("edited while offline"));
    await b.engine.whenIdle(); // safe offline — no catch-up, no hang.
    expect(await readNote(b, A_MD)).toBe("edited while offline");

    // Heal the partition and drive to a joint fixed point. The whole point: this
    // must NOT throw (the C3 coin-flip), regardless of which side won the index LWW.
    b.transport.goOnline();
    await converge(a, b);

    // THE ROBUST INVARIANT: the edited content survives on BOTH vaults.
    expect(await readNote(a, A_MD)).toBe("edited while offline");
    expect(await readNote(b, A_MD)).toBe("edited while offline");

    // No false quiescence and no lingering pending work on either side.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });
});

/**
 * Phase 0b-2 Task 3 — BOOTSTRAP routes BOUND paths through `applyBootstrap` (M1/M2).
 *
 * A 2nd device joining with a pre-existing DIVERGENT local copy of a note must NOT
 * have its local content silently overwritten. The divergence routes to a
 * SUPERVISED IMPORT: adopt the server text as the live note, PARK the divergent
 * local copy as a deterministic conflict artifact, and surface ONE inbox entry —
 * zero content lost (M1). A BYTE-IDENTICAL local copy must adopt the server docId
 * with NO conflict/inbox and no doubled content (M2 — the zero-attach landmine guard).
 */
describe("SyncEngine bootstrap (Task 3 — divergent-adopt + supervised-import + zero-attach, M1/M2)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("divergent local file at adopt → supervised-import, no content lost (M1)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A seeds + starts + converges `a.md` = "server-body".
    await a.vault.writeAtomic(A_MD, utf8("server-body"));
    await a.engine.start();
    await a.engine.waitConverged();

    // B has a DIVERGENT local `a.md` BEFORE it starts (the cardinal onboarding flow).
    await b.vault.writeAtomic(A_MD, utf8("my-local-draft"));
    await b.engine.start();
    await converge(a, b);

    // 1. B's live note is the ADOPTED server content (never silently kept B's draft,
    //    never a merge3-blended hybrid).
    expect(await readNote(b, A_MD)).toBe("server-body");

    // 2. B's divergent draft is PARKED as a conflict artifact — content NOT lost.
    const listed = await b.vault.list();
    const artifacts = listed
      .map((f) => f.path)
      .filter((p) => p.includes("(conflict, dev-b,") && p !== A_MD);
    expect(artifacts).toHaveLength(1);
    const [artifactPath] = artifacts;
    if (artifactPath === undefined) throw new Error("no conflict artifact");
    expect(await readNote(b, artifactPath)).toBe("my-local-draft");

    // 3. EXACTLY ONE supervised-import inbox entry on B, pointing at the artifact.
    const sup = b.engine.inbox.list().filter((e) => e.kind === "supervised-import");
    expect(sup).toHaveLength(1);
    const [entry] = sup;
    if (entry === undefined) throw new Error("no supervised-import inbox entry");
    expect(entry.path).toBe(A_MD);
    expect(entry.artifactPath).toBe(artifactPath);

    // 4. A is untouched by B's onboarding; both engines quiescent.
    expect(await readNote(a, A_MD)).toBe("server-body");
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("byte-identical adopt → adopts server docId, zero conflict/inbox (M2)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A seeds `a.md`.
    await a.vault.writeAtomic(A_MD, utf8("shared-body"));
    await a.engine.start();
    await a.engine.waitConverged();
    const serverDocId = a.engine.index.get(A_MD)?.docId;
    expect(serverDocId).toBeDefined();

    // B has a BYTE-IDENTICAL local `a.md` before it starts.
    await b.vault.writeAtomic(A_MD, utf8("shared-body"));
    await b.engine.start();
    await converge(a, b);

    // B adopts A's docId (no second docId minted → no doubled content).
    expect(b.engine.index.get(A_MD)?.docId).toBe(serverDocId);

    // Content intact, NO conflict artifact, NO inbox entry.
    expect(await readNote(b, A_MD)).toBe("shared-body");
    const artifacts = (await b.vault.list())
      .map((f) => f.path)
      .filter((p) => p.includes("(conflict,"));
    expect(artifacts).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);

    // Joint quiescence.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });
});

/**
 * Phase 0b-2 Task 4 — CONCURRENT-CREATE LOSER RECOVERY (C2).
 *
 * Two devices that each CREATE the same path with DIFFERENT content (the classic
 * "both make today's daily note offline") each seed their OWN docId. The index
 * `tree` LWW binds the path to ONE winner docId; the loser docId is orphaned (in
 * the loser's docStore, unbound by any live tree entry). Without recovery the
 * loser's content is DESTROYED. With create-metadata (replicated in the seeded
 * doc) + the structural-pass orphan sweep, the loser is RECOVERED to a
 * deterministic `name (conflict, <createdBy>, <createdTs>).md`, REUSING the orphan
 * docId, and the recovered content propagates to BOTH vaults. Zero content lost.
 */
const DAILY_MD = path("daily.md");

function lossPath(loserDeviceId: string, original: VaultPath = DAILY_MD): VaultPath {
  // FakeClock starts at 0, so createdTs is "0" for a pre-start seed.
  // ORPHAN RECOVERY is BESIDE-ORIGINAL (a live, SYNCING index entry) — NOT under
  // _conflicts/. Only real conflict BACKUPS go device-local; recovered content syncs.
  const dot = original.lastIndexOf(".");
  const suffix = ` (conflict, ${loserDeviceId}, 0)`;
  return (original.slice(0, dot) + suffix + original.slice(dot)) as VaultPath;
}

describe("SyncEngine concurrent-create recovery (Task 4 — C2 loser recovery, no content lost)", () => {
  let a: Device;
  let b: Device;
  let c: Device | undefined;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
    if (c !== undefined) await c.engine.stop();
    c = undefined;
  });

  it("concurrent-create same path keeps BOTH contents (C2)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // GENUINE concurrent-create: both devices are OFFLINE when they each create the
    // SAME path with DIFFERENT content, so each seeds its OWN docId (neither sees the
    // other's index). On heal the index LWW binds the path to one winner; the loser
    // docId is orphaned in the loser's docStore.
    a.transport.goOffline();
    b.transport.goOffline();
    await a.vault.writeAtomic(DAILY_MD, utf8("from-A"));
    await b.vault.writeAtomic(DAILY_MD, utf8("from-B"));

    await a.engine.start();
    await b.engine.start();
    await a.engine.whenIdle();
    await b.engine.whenIdle();

    a.transport.goOnline();
    b.transport.goOnline();
    await convergeAll(a, b);

    // The index LWW picked ONE winner at daily.md; the other is the recovered loser.
    const winner = await readNote(a, DAILY_MD);
    expect(winner === "from-A" || winner === "from-B").toBe(true);
    const loserDevice = winner === "from-A" ? "dev-b" : "dev-a";
    const loserContent = winner === "from-A" ? "from-B" : "from-A";
    const recoveredPath = lossPath(loserDevice);

    // BOTH vaults carry BOTH contents: winner at daily.md, loser at the recovery path.
    expect(await readNote(b, DAILY_MD)).toBe(winner);
    expect(await readNote(a, recoveredPath)).toBe(loserContent);
    expect(await readNote(b, recoveredPath)).toBe(loserContent);

    // NEITHER content was lost.
    const aFiles = (await a.vault.list()).map((f) => f.path).sort();
    const bFiles = (await b.vault.list()).map((f) => f.path).sort();
    expect(aFiles).toContain(DAILY_MD);
    expect(aFiles).toContain(recoveredPath);
    // Same FILE SET on both vaults.
    expect(aFiles).toEqual(bFiles);

    // Exactly ONE recovery inbox entry, on both devices, pointing at the recovery path.
    for (const d of [a, b]) {
      const conflicts = d.engine.inbox.list().filter((e) => e.kind === "conflict");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.path).toBe(recoveredPath);
    }

    // Joint quiescence.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("three devices create the same path → idempotent recovery (NEW-3)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    c = makeDevice(bus, "dev-c", "Device C");

    a.transport.goOffline();
    b.transport.goOffline();
    c.transport.goOffline();
    await a.vault.writeAtomic(DAILY_MD, utf8("from-A"));
    await b.vault.writeAtomic(DAILY_MD, utf8("from-B"));
    await c.vault.writeAtomic(DAILY_MD, utf8("from-C"));

    await a.engine.start();
    await b.engine.start();
    await c.engine.start();
    await a.engine.whenIdle();
    await b.engine.whenIdle();
    await c.engine.whenIdle();

    a.transport.goOnline();
    b.transport.goOnline();
    c.transport.goOnline();
    await convergeAll(a, b, c);

    // One winner at daily.md; the OTHER TWO are recovered as deterministic losers.
    const winner = await readNote(a, DAILY_MD);
    const byContent: Record<string, string> = {
      "from-A": "dev-a",
      "from-B": "dev-b",
      "from-C": "dev-c",
    };
    if (winner === null) throw new Error("no winner at daily.md");
    const losers = (["from-A", "from-B", "from-C"] as const).filter((t) => t !== winner);

    // Every device holds the SAME file set, and EVERY content survives at its path.
    const aFiles = (await a.vault.list()).map((f) => f.path).sort();
    const bFiles = (await b.vault.list()).map((f) => f.path).sort();
    const cFiles = (await c.vault.list()).map((f) => f.path).sort();
    expect(aFiles).toEqual(bFiles);
    expect(aFiles).toEqual(cFiles);

    for (const d of [a, b, c]) {
      expect(await readNote(d, DAILY_MD)).toBe(winner);
      for (const content of losers) {
        const p = lossPath(byContent[content] ?? "", DAILY_MD);
        expect(await readNote(d, p)).toBe(content);
      }
    }

    // No duplicate recovery paths: exactly TWO recovery files (one per loser).
    const recoveries = aFiles.filter((p) => p.includes("(conflict,"));
    expect(recoveries).toHaveLength(2);

    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
    expect(await c.engine.pendingDocs()).toEqual([]);
  });

  // POST-start concurrent-create is OUT OF SCOPE for Task 4 (design D5): the loser
  // doc must reach the recovering device's docStore for the sweep to materialize it,
  // which only the PRE-START seed guarantees today.
  // TODO(follow-up): loser doc must reach docStore for post-start collisions
  it.skip("POST-start concurrent-create (deferred, D5)", () => {
    // Intentionally empty — documents the deferral.
  });
});

/**
 * Phase 0b-2 Task 5 — RENAME PROPAGATION (M3) + DIVERGENT-RENAME RESOLUTION.
 *
 * `applyRename` re-keys the index (old key tombstoned, new key live, SAME docId —
 * content continuity), but NO `vault.rename` ever ran on a peer's disk: the peer
 * kept the OLD name forever (the new name only appeared if a later content edit
 * happened to materialize it). The structural reconciler must detect this index
 * state — a tombstoned `oldPath` whose docId is ALSO live at a different `newPath`,
 * with a file at `oldPath` and none at `newPath` — and `vault.rename` it.
 *
 * The interplay is subtle: a renamed note's OLD-key tombstone records the
 * (unchanged) content hash, so the delete concern would naively call it an
 * uncontested delete and `vault.remove` the old file. The rename concern runs
 * BEFORE the delete concern, and the delete concern SKIPS any tombstone whose
 * docId is still live elsewhere (a move, not a deletion).
 *
 * DIVERGENT RENAME: two devices rename the SAME docId to DIFFERENT names while
 * partitioned; after the index converges the docId is live at TWO paths. The
 * deterministic resolver (lexicographically-smallest path wins) tombstones the
 * loser so every replica converges on ONE name with zero content lost.
 */
describe("SyncEngine rename propagation (Task 5 — M3 rename reaches peer disk + divergent resolve)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("rename propagates to peer disk (same docId, no loop, no spurious conflict)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A & B converge on `a.md`.
    await a.vault.writeAtomic(A_MD, utf8("body to carry"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("body to carry");
    const docIdBefore = a.engine.index.get(A_MD)?.docId;
    expect(docIdBefore).toBeDefined();

    // SPY on B's vault so we can prove the propagation used a `vault.rename`
    // (a true rename — content continuity) and NOT a `vault.remove(a.md)` that
    // mis-handles the rename's old-key tombstone as a deletion.
    const bRenames: [VaultPath, VaultPath][] = [];
    const bRemoves: VaultPath[] = [];
    const origRename = b.vault.rename.bind(b.vault);
    const origRemove = b.vault.remove.bind(b.vault);
    b.vault.rename = (from, to) => {
      bRenames.push([from, to]);
      return origRename(from, to);
    };
    b.vault.remove = (p) => {
      bRemoves.push(p);
      return origRemove(p);
    };

    // A renames `a.md` → `b.md` via a REAL vault rename event (FakeVault.rename
    // emits `{ type: "rename", path: to, oldPath: from }`). `onVaultEvent` re-keys
    // A's index (b.md live, a.md tombstoned, SAME docId); this replicates to B.
    const B_MD = path("b.md");
    await a.vault.rename(A_MD, B_MD);
    await converge(a, b);

    // B propagated the rename as EXACTLY ONE true rename (no echo loop re-running
    // it), never as a remove of `a.md` (which would mis-handle the rename's
    // old-key tombstone as a deletion).
    expect(bRenames).toEqual([[A_MD, B_MD]]);
    expect(bRemoves).not.toContain(A_MD);

    // B's disk now has `b.md` with the original content and NO `a.md`.
    expect(await readNote(b, B_MD)).toBe("body to carry");
    expect(await readNote(b, A_MD)).toBeNull();

    // A's own disk is unchanged by the propagation (already renamed locally).
    expect(await readNote(a, B_MD)).toBe("body to carry");
    expect(await readNote(a, A_MD)).toBeNull();

    // docId UNCHANGED on both — content continuity, not a re-create.
    expect(a.engine.index.get(B_MD)?.docId).toBe(docIdBefore);
    expect(b.engine.index.get(B_MD)?.docId).toBe(docIdBefore);

    // No false quiescence, no loop (the 15s timeout would trip one), no spurious
    // conflict / resurrection / inbox.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
    expect(a.engine.inbox.list()).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);
  });

  it("divergent concurrent rename converges to one deterministic name (no content lost)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A & B converge on `a.md`.
    await a.vault.writeAtomic(A_MD, utf8("shared body"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readNote(b, A_MD)).toBe("shared body");

    // Partition; each side renames the SAME note to a DIFFERENT name offline.
    const X_MD = path("x.md");
    const Y_MD = path("y.md");
    b.transport.goOffline();

    await a.vault.rename(A_MD, X_MD);
    await a.engine.whenIdle();
    expect(await readNote(a, X_MD)).toBe("shared body");

    await b.vault.rename(A_MD, Y_MD);
    await b.engine.whenIdle();
    expect(await readNote(b, Y_MD)).toBe("shared body");

    // Heal + drive to a joint fixed point. BOTH converge on the lexicographically
    // smaller name `x.md`; `y.md` is gone; content preserved; nothing lost.
    b.transport.goOnline();
    await converge(a, b);

    for (const d of [a, b]) {
      expect(await readNote(d, X_MD)).toBe("shared body");
      expect(await readNote(d, Y_MD)).toBeNull();
      expect(await readNote(d, A_MD)).toBeNull();
    }

    // Same single live note on both, same docId (content continuity).
    expect(a.engine.index.get(X_MD)?.docId).toBe(b.engine.index.get(X_MD)?.docId);
    expect(a.engine.index.get(X_MD)?.docId).toBeDefined();

    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 7 (M4) — stop() MUST detach every note-doc transport peer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After start() + converge() + stop(), the shared InProcessBus MUST show ZERO
 * registered peers for every NOTE docId that was attached during the session.
 * Before the fix, the per-note AttachedDoc handles returned by transport.attach()
 * inside LazyAttachManager.runCatchUp were DROPPED — never .detach()-ed — so bus
 * peers for note docs lingered after stop(), leaking doc.onUpdate subscriptions.
 */
describe("SyncEngine stop() — note-doc transport peer cleanup (M4)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    // engines are already stopped in each test; guard against early-exit leaks
    await a.engine.stop().catch(() => undefined);
    await b.engine.stop().catch(() => undefined);
  });

  it("after stop(), bus reports ZERO peers for every note docId", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // Converge so at least one note doc is lazily attached on BOTH engines.
    await a.vault.writeAtomic(A_MD, utf8("body"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // Collect the note docId so we can inspect the bus after stop().
    const noteDocId = a.engine.index.get(A_MD)?.docId;
    if (noteDocId === undefined) throw new Error("expected note entry in index");

    // BEFORE fix: peers linger after stop(); bus.peerCount(noteDocId) > 0.
    await a.engine.stop();
    await b.engine.stop();

    // ASSERT: ZERO registered note-doc peers on the bus after both engines stopped.
    expect(bus.peerCount(noteDocId)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 7 (item 6) — reconcileDirtyDoc writes base BEFORE file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The torn-pair rule: base must be persisted BEFORE the vault write, so a crash
 * between the two leaves the base in a recoverable state (matching OutboundPipeline).
 * Before the fix, reconcileDirtyDoc wrote the file BEFORE the base, inverting the
 * ordering that onRemoteUpdate correctly follows.
 *
 * We verify ordering by spying on BaseStore.save and FakeVault.writeAtomic call order.
 */
describe("SyncEngine reconcileDirtyDoc — base saved BEFORE vault write (item 6)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop().catch(() => undefined);
    await b.engine.stop().catch(() => undefined);
  });

  it("base.save is called before vault.writeAtomic during dirty-doc reconciliation", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // Phase 1: A & B converge on a.md = "v1".
    await a.vault.writeAtomic(A_MD, utf8("v1"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // Phase 2: A goes offline; B edits the note to "v2" (changes the shared CRDT).
    a.transport.goOffline();
    await b.vault.writeAtomic(A_MD, utf8("v2"));
    await b.engine.whenIdle();

    // Phase 3: WHILE A is still offline, A edits locally to "v1-edit".
    // This creates a dirty doc on A (disk = "v1-edit", CRDT = "v1").
    await a.vault.writeAtomic(A_MD, utf8("v1-edit"));
    await a.engine.whenIdle();

    // Spy on the call order BEFORE reconnecting so we capture reconcileDirtyDoc.
    const callOrder: string[] = [];

    const origBaseSave = a.engine.base.save.bind(a.engine.base);
    a.engine.base.save = async (...args) => {
      callOrder.push("base.save");
      return origBaseSave(...args);
    };

    const origWrite = a.vault.writeAtomic.bind(a.vault);
    a.vault.writeAtomic = async (p, data) => {
      callOrder.push("vault.writeAtomic");
      return origWrite(p, data);
    };

    // Phase 4: Reconnect and converge — dirty-doc reconcile runs on A,
    // and since merged ("v1-edit" merged with "v2") != "v1-edit", vault.writeAtomic
    // WILL be called (content changed by remote side while A was offline).
    a.transport.goOnline();
    await converge(a, b);

    // ASSERT: base.save must appear before vault.writeAtomic in the call sequence.
    const baseSaveIdx = callOrder.indexOf("base.save");
    const writeIdx = callOrder.indexOf("vault.writeAtomic");

    // base.save must have been called at least once.
    expect(baseSaveIdx).toBeGreaterThanOrEqual(0);
    // If a vault write happened, base.save must strictly precede it.
    if (writeIdx !== -1) {
      expect(baseSaveIdx).toBeLessThan(writeIdx);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 8 (a) — LOOP/CONVERGENCE STORM (loop-safety bound D2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single MIXED structural storm across THREE engines that must reach a FIXED
 * POINT. This proves the loop-safety bound D2: the structural pass writes index /
 * inbox / vault but QUIESCES — a relay loop (A's reconcile bumps B, whose reconcile
 * bumps A, …) would never settle and would trip the suite's 15s timeout / 1GB heap
 * cap inside `waitConverged`/`convergeAll` instead of returning.
 *
 * The storm interleaves EVERY structural concern in one run, on top of each other:
 *   • a DELETE (uncontested → must vanish on all three),
 *   • a concurrent EDIT-BEATS-DELETE on a second note (offline edit resurrects it),
 *   • a RENAME of a third note (re-key propagates to peer disk),
 *   • offline / online interleaving so the index changes pile up and replay on heal.
 *
 * The KEY assertion is simply that `convergeAll` RETURNS (no throw / timeout / OOM).
 * On top of that: all three vaults are byte-identical, and the synced inbox
 * CONVERGES IDENTICALLY across all peers (same entry-id set everywhere) — a relay
 * loop or a non-deterministic reconcile would break one of these.
 */
describe("SyncEngine structural storm (Task 8a — mixed structural pass reaches a fixed point, D2)", () => {
  let a: Device;
  let b: Device;
  let c: Device;

  afterEach(async () => {
    await a.engine.stop().catch(() => undefined);
    await b.engine.stop().catch(() => undefined);
    await c.engine.stop().catch(() => undefined);
  });

  /**
   * Snapshot the SYNCED vault (user-visible notes) for a byte-identical compare.
   * EXCLUDES `.obsidian/zync/…` BaseStore records: those classify as `excluded`,
   * are never synced, and a DELETED doc keeps a device-specific base record (local
   * resurrection state) — so they legitimately differ per device. Convergence is a
   * property of the synced notes, not of excluded local metadata.
   */
  async function snapshot(d: Device): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const { path: p } of await d.vault.list()) {
      if (p.startsWith(".obsidian/zync/")) continue;
      const bytes = await d.vault.read(p);
      if (bytes !== null) out[p] = decode(bytes);
    }
    return out;
  }

  /** Stable, comparable view of a synced inbox: sorted `kind:path:id` triples. */
  function inboxView(d: Device): string[] {
    return d.engine.inbox
      .list()
      .map((e) => `${e.kind}|${e.path}|${e.id}`)
      .sort();
  }

  it("delete + edit-beats-delete + rename in one offline/online burst converges to a fixed point", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");
    c = makeDevice(bus, "dev-c", "Device C");

    // Seed three notes on A BEFORE start so all three bootstrap-seed + attach on
    // every device: DOOMED (to be deleted), SURVIVOR (edit-beats-delete), MOVER
    // (to be renamed).
    const DOOMED = path("doomed.md");
    const SURVIVOR = path("survivor.md");
    const MOVER = path("mover.md");
    const MOVED = path("moved.md");
    await a.vault.writeAtomic(DOOMED, utf8("doomed body"));
    await a.vault.writeAtomic(SURVIVOR, utf8("survivor v1"));
    await a.vault.writeAtomic(MOVER, utf8("mover body"));

    await a.engine.start();
    await b.engine.start();
    await c.engine.start();
    await convergeAll(a, b, c);

    // Everyone adopted all three notes before the storm.
    for (const d of [a, b, c]) {
      expect(await readNote(d, DOOMED)).toBe("doomed body");
      expect(await readNote(d, SURVIVOR)).toBe("survivor v1");
      expect(await readNote(d, MOVER)).toBe("mover body");
    }

    // ── THE STORM: partition C, then pile structural ops on top of each other ──
    c.transport.goOffline();

    // (1) A deletes DOOMED while C is offline → tombstone replicates to B now, to C
    //     on heal. Uncontested delete → must be gone everywhere at quiescence.
    await a.vault.remove(DOOMED);
    await a.engine.whenIdle();

    // (2) EDIT-BEATS-DELETE on SURVIVOR: A deletes it (lays a tombstone) while C,
    //     OFFLINE, edits the SAME note. The offline edit must beat the delete and
    //     resurrect the note at C's content on ALL three devices.
    await a.vault.remove(SURVIVOR);
    await a.engine.whenIdle();
    await c.vault.writeAtomic(SURVIVOR, utf8("survivor RESURRECTED by C"));
    await c.engine.whenIdle(); // safe offline — no catch-up, no hang.

    // (3) RENAME MOVER → MOVED on B (online). The re-key replicates; structural
    //     reconcile must `vault.rename` it on A now and on C after heal.
    await b.vault.rename(MOVER, MOVED);
    await b.engine.whenIdle();

    // Heal C and drive the whole mess to a JOINT FIXED POINT. The crux: this RETURNS
    // (a relay loop would blow the 15s/1GB cap inside convergeAll instead).
    c.transport.goOnline();
    await convergeAll(a, b, c);

    // ── CONVERGENCE INVARIANTS ──
    // Uncontested delete: DOOMED is gone on all three.
    for (const d of [a, b, c]) expect(await readNote(d, DOOMED)).toBeNull();

    // Edit-beats-delete: SURVIVOR resurrected at C's content on all three.
    for (const d of [a, b, c]) {
      expect(await readNote(d, SURVIVOR)).toBe("survivor RESURRECTED by C");
    }

    // Rename: MOVED exists with the carried content, MOVER is gone, on all three.
    for (const d of [a, b, c]) {
      expect(await readNote(d, MOVED)).toBe("mover body");
      expect(await readNote(d, MOVER)).toBeNull();
    }

    // Every vault is byte-identical (the storm settled to one shared state).
    const ref = await snapshot(a);
    expect(await snapshot(b)).toEqual(ref);
    expect(await snapshot(c)).toEqual(ref);

    // The synced inbox converges IDENTICALLY across all peers (same entry set).
    const inboxA = inboxView(a);
    expect(inboxView(b)).toEqual(inboxA);
    expect(inboxView(c)).toEqual(inboxA);

    // No false quiescence anywhere.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
    expect(await c.engine.pendingDocs()).toEqual([]);
  });
});
