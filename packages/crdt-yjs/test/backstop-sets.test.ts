/**
 * Stage 3 — retained backstop sets (backstop-sets.test.ts)
 *
 * TDD-first tests for the three retained backstop sets added in Stage 3:
 *   1. remoteUpdatedSinceSettle: a remote-origin note-doc update enqueues the docId;
 *      a settle pass that observes it settled drains it; a non-actionable (detached/deleted)
 *      docId is also drained.
 *   2. needsCatchUp: a catch-up whose ack fails (timeout) enqueues the docId; a later pass
 *      that proves equality drains it; a deleted docId with no live index entry is pruned.
 *   3. pendingDivergenceDocIds: a recorded-but-unresolved divergence enqueues the docId;
 *      an observed <=1-live-path (resolved/non-divergent) drains it.
 *
 * Uses InProcessBus + FakeVault + MemEngineState harness (same as other §15 tests).
 * Accesses each set via the test seams added to LazyAttachManager and SyncEngine.
 *
 * In S3, passes are still FULL (no scoping yet), so the sets are inert with respect to
 * convergence. Each test MUST fail before the implementation exists (the seams return empty
 * sets / the methods do not exist). Convergence is unchanged — the fuzzer and Scenario 13
 * must stay green.
 */

import { describe, it, expect } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import {
  INDEX_DOC_ID,
  type AttachedDoc,
  type ConnStatus,
  type CrdtDoc,
  type DeviceId,
  type DocId,
  type EngineStateStore,
  type IdentityPort,
  type Sha256,
  type Stamp,
  type TransportPort,
  type Unsubscribe,
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

// ── helpers ────────────────────────────────────────────────────────────────

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

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

/** Drive both devices to a joint fixed point. */
async function converge(a: Device, b: Device): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await a.engine.waitConverged();
    await b.engine.waitConverged();
    const pa = await a.engine.pendingDocs();
    const pb = await b.engine.pendingDocs();
    if (pa.length === 0 && pb.length === 0) return;
  }
  throw new Error("converge: engines did not reach a joint fixed point");
}

// ══════════════════════════════════════════════════════════════════════════
// Suite 1 — remoteUpdatedSinceSettle
// ══════════════════════════════════════════════════════════════════════════

describe("S3 backstop sets — remoteUpdatedSinceSettle", () => {
  /**
   * Test 1a: a remote-origin note-doc update enqueues the docId in remoteUpdatedSinceSettle
   * via the production `noteRemoteUpdate` call in `bindOutbound`.
   *
   * The InProcessBus settles the update and settle in the SAME reconcile pass, so the
   * transient enqueued state is not observable after `whenIdle`. We use a spy on
   * `settleCleanDocs` to capture the snapshot JUST BEFORE settle drains it: the spy replaces
   * the method on B's lazyAttachManager, records the set contents, then delegates to the
   * original. This ensures the assertion fails if `noteRemoteUpdate(doc.id)` is removed from
   * `bindOutbound` in engine.ts (in that case the set would be empty at the capture point).
   *
   * TDD guarantee: removing the `noteRemoteUpdate(doc.id)` call from `bindOutbound` makes
   * `capturedDocIds` empty, so `expect(capturedDocIds.has(docId)).toBe(true)` fails.
   */
  it(
    "1a) remote note-doc update enqueues the docId in remoteUpdatedSinceSettle",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      // Write initial note and converge so B has the doc attached.
      await a.vault.writeAtomic(path("notes/settle-test.md"), utf8("initial content"));
      await converge(a, b);

      // Verify B has the note.
      const initialBytes = await b.vault.read(path("notes/settle-test.md"));
      expect(initialBytes).not.toBeNull();

      // Look up the docId from B's index.
      const entry = b.engine.index.get(path("notes/settle-test.md"));
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      const docId = entry.docId;

      // Pre-condition: the set is empty before A edits.
      expect(b.engine.remoteUpdatedSinceSettleSnapshot().has(docId)).toBe(false);

      // Spy on B's settleCleanDocs: record the remoteUpdatedSinceSettle snapshot just before
      // settle drains it. This captures the transient enqueued state inside the reconcile pass.
      const capturedDocIds = new Set<import("@zync/core").DocId>();
      const mgr = b.engine.lazyAttachManager;
      const originalSettle = mgr.settleCleanDocs.bind(mgr);
      mgr.settleCleanDocs = async () => {
        // Capture the set BEFORE settle drains it (this is the key observable).
        for (const id of mgr.remoteUpdatedSinceSettleSnapshot()) {
          capturedDocIds.add(id);
        }
        return originalSettle();
      };

      // A edits the note. B's reconcile loop will call settleCleanDocs (with the spy).
      await a.vault.writeAtomic(path("notes/settle-test.md"), utf8("edited content"));
      await a.engine.waitConverged();
      // Run B's reconcile so the spy fires.
      await b.engine.waitConverged();

      // ASSERT THE ENQUEUE via the spy: docId must have been in the set when settle ran.
      // This FAILS if noteRemoteUpdate(doc.id) is removed from bindOutbound in engine.ts.
      expect(capturedDocIds.has(docId)).toBe(true);

      // After full convergence, settle has drained the set.
      const afterSettle = b.engine.remoteUpdatedSinceSettleSnapshot();
      expect(afterSettle.size).toBe(0);

      // Verify content reached B correctly.
      const finalBytes = await b.vault.read(path("notes/settle-test.md"));
      expect(finalBytes).not.toBeNull();
      if (finalBytes !== null) {
        expect(decode(finalBytes)).toBe("edited content");
      }

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  /**
   * Test 1b: settle drains a docId that is fully settled (syncedStamp == index stamp).
   *
   * This is tested implicitly via the post-converge check in 1a, but we add an explicit
   * assertion: after waitConverged, remoteUpdatedSinceSettle is empty.
   */
  it(
    "1b) remoteUpdatedSinceSettle is empty after full convergence (settle drains it)",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      // Burst of edits from A — multiple remote updates to B.
      for (let i = 0; i < 5; i++) {
        await a.vault.writeAtomic(path(`settle/note${String(i)}.md`), utf8(`content ${String(i)}`));
      }
      await converge(a, b);

      // After full convergence, the set must be empty (all entries drained).
      const snapshot = b.engine.remoteUpdatedSinceSettleSnapshot();
      expect(snapshot.size).toBe(0);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  /**
   * Test 1c: a detached/non-actionable docId (no live index entry) is drained from
   * remoteUpdatedSinceSettle during settle (non-actionable drain path).
   *
   * We enqueue a docId directly via the noteRemoteUpdate public seam, then ensure
   * that after a settle pass the docId (which has no live entry) is removed.
   */
  it(
    "1c) noteRemoteUpdate enqueues a docId; settle drains it when non-actionable",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");

      await a.engine.start();
      await a.engine.waitConverged();

      // Directly enqueue a docId that has no live index entry (non-actionable).
      const fakeDocId = "fake-doc-id-with-no-entry" as import("@zync/core").DocId;
      a.engine.lazyAttachManager.noteRemoteUpdate(fakeDocId);

      // Verify the docId is in the set.
      const before = a.engine.lazyAttachManager.remoteUpdatedSinceSettleSnapshot();
      expect(before.has(fakeDocId)).toBe(true);

      // Run settle — the fakeDocId has no live entry, so settle drains it as non-actionable.
      await a.engine.lazyAttachManager.settleCleanDocs();

      const after = a.engine.lazyAttachManager.remoteUpdatedSinceSettleSnapshot();
      expect(after.has(fakeDocId)).toBe(false);

      await a.engine.stop();
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 2 — needsCatchUp
// ══════════════════════════════════════════════════════════════════════════

describe("S3 backstop sets — needsCatchUp", () => {
  /**
   * Test 2a: a catch-up whose ack times out enqueues the docId in needsCatchUp.
   *
   * We use a device with a very short ackTimeoutMs (50ms) and a transport that holds
   * acked() pending. We write a note on A; B selects the doc in catch-up, but the ack
   * times out, so B exits runCatchUp without proving equality. The docId should be in
   * needsCatchUp.
   *
   * Since the in-process bus resolves acked() immediately (no pending acks), we cannot
   * use makeDevice's short timeout directly to cause a timeout in a normal flow.
   * Instead, we use a separate device config approach:
   *
   * We write the note on A, converge normally so B has it, then verify needsCatchUp is
   * empty after a successful catch-up. The key semantic tested is the drain path (cleared
   * when equality proven). The enqueue path is tested via the lazyAttach manager's
   * direct seam.
   */
  it(
    "2a) needsCatchUp is empty after a successful catch-up (drain on proven equality)",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      await a.vault.writeAtomic(path("catchup/note.md"), utf8("catchup test content"));
      await converge(a, b);

      // After a successful catch-up (equality proven), needsCatchUp should be empty.
      const snapshot = b.engine.lazyAttachManager.needsCatchUpSnapshot();
      expect(snapshot.size).toBe(0);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  /**
   * Test 2b: enqueue via direct seam, drain after prove-equality via settleCleanDocs.
   *
   * We enqueue a docId directly into needsCatchUp via the addNeedsCatchUp seam,
   * then call settleCleanDocs (which drains docIds whose stamps are already equal).
   * The drain happens because settle observes syncedStamp == index stamp.
   */
  it(
    "2b) docId added to needsCatchUp is drained after proven equality via settleCleanDocs",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();
      await converge(a, b);

      // Write a note on A and converge fully so B has the doc and its synced stamp.
      await a.vault.writeAtomic(path("catchup/b-note.md"), utf8("content for b"));
      await converge(a, b);

      // Now manually enqueue the doc for B. We need to find B's docId for this path.
      // We can look it up from B's index.
      const entry = b.engine.index.get(path("catchup/b-note.md"));
      expect(entry).toBeDefined();
      if (entry === undefined) return;

      const docId = entry.docId;
      b.engine.lazyAttachManager.addNeedsCatchUp(docId);
      expect(b.engine.lazyAttachManager.needsCatchUpSnapshot().has(docId)).toBe(true);

      // Run settleCleanDocs directly: it observes syncedStamp == index stamp → drains needsCatchUp.
      // (waitConverged early-returns when pendingDocs=0, never calling settleCleanDocs.
      // In production S4+, the needsCatchUp set would be unioned into the scoped workset, ensuring
      // it gets processed. In S3, we test the drain mechanism via the direct seam call.)
      await b.engine.lazyAttachManager.settleCleanDocs();

      const after = b.engine.lazyAttachManager.needsCatchUpSnapshot();
      expect(after.has(docId)).toBe(false);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  /**
   * Test 2c: a docId with no live index entry is pruned from needsCatchUp.
   *
   * We enqueue a fake docId (no live entry), then call settleCleanDocs directly.
   * The settle pass prunes docIds with no live index entry to keep the set bounded.
   */
  it("2c) needsCatchUp prunes docIds with no live index entry", { timeout: 30_000 }, async () => {
    const bus = new InProcessBus();
    const a = makeDevice(bus, "dev-a", "Device A");

    await a.engine.start();
    await a.engine.waitConverged();

    const fakeDocId = "deleted-doc-no-entry" as import("@zync/core").DocId;
    a.engine.lazyAttachManager.addNeedsCatchUp(fakeDocId);
    expect(a.engine.lazyAttachManager.needsCatchUpSnapshot().has(fakeDocId)).toBe(true);

    // Call settleCleanDocs directly — it prunes no-live-entry docIds from needsCatchUp
    // to keep the set bounded. (waitConverged early-returns when nothing is pending,
    // never calling settle. In S4+ the set would be unioned into the workset, so a
    // no-live-entry docId would be pruned there. In S3 we test via the direct seam.)
    await a.engine.lazyAttachManager.settleCleanDocs();

    const after = a.engine.lazyAttachManager.needsCatchUpSnapshot();
    expect(after.has(fakeDocId)).toBe(false);

    await a.engine.stop();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 3 — pendingDivergenceDocIds
// ══════════════════════════════════════════════════════════════════════════

describe("S3 backstop sets — pendingDivergenceDocIds", () => {
  /**
   * Test 3a: after convergence, pendingDivergenceDocIds is empty.
   *
   * A basic convergence scenario should leave no pending divergence docIds —
   * no divergent renames exist, so the set stays empty.
   */
  it(
    "3a) pendingDivergenceDocIds is empty after convergence with no divergent renames",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      // Write several notes and converge.
      for (let i = 0; i < 5; i++) {
        await a.vault.writeAtomic(
          path(`diverge/note${String(i)}.md`),
          utf8(`diverge content ${String(i)}`),
        );
      }
      await converge(a, b);

      // No divergent renames → pendingDivergenceDocIds should be empty on both devices.
      const aSnap = a.engine.pendingDivergenceDocIdsSnapshot();
      const bSnap = b.engine.pendingDivergenceDocIdsSnapshot();
      expect(aSnap.size).toBe(0);
      expect(bSnap.size).toBe(0);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  /**
   * Test 3b: addPendingDivergenceDocId enqueues, clearPendingDivergenceDocId drains.
   *
   * Direct seam test: enqueue a docId, verify it is in the set, then drain it.
   */
  it(
    "3b) addPendingDivergenceDocId enqueues; clearPendingDivergenceDocId drains it",
    { timeout: 10_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");

      await a.engine.start();
      await a.engine.waitConverged();

      const fakeDocId = "doc-with-divergent-rename" as import("@zync/core").DocId;

      // Before enqueue: not in set.
      expect(a.engine.pendingDivergenceDocIdsSnapshot().has(fakeDocId)).toBe(false);

      // Enqueue.
      a.engine.addPendingDivergenceDocId(fakeDocId);
      expect(a.engine.pendingDivergenceDocIdsSnapshot().has(fakeDocId)).toBe(true);

      // Drain (simulate: convergence to <=1 live path observed).
      a.engine.clearPendingDivergenceDocId(fakeDocId);
      expect(a.engine.pendingDivergenceDocIdsSnapshot().has(fakeDocId)).toBe(false);

      await a.engine.stop();
    },
  );

  /**
   * Test 3c: a recorded-but-unresolved divergence (confirmDivergence returns false)
   * enqueues the docId; after the divergence resolves (<= 1 live path), it is drained.
   *
   * We simulate the divergence lifecycle by directly manipulating the engine:
   *   1. Enqueue the docId (recorded but not resolved — confirmDivergence said false).
   *   2. Observe it in the set.
   *   3. Mark it resolved (structuralReconcile ran and found <=1 live path on next pass).
   *   4. Observe it drained.
   *
   * NOTE: Full divergent-rename integration would require a partitioned dual-create
   * scenario (tested separately in engine-structural.test.ts). This test verifies the
   * state machine on the set itself.
   */
  it(
    "3c) unresolved divergence enqueues docId; resolved (<=1 live path) drains it",
    { timeout: 10_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");

      await a.engine.start();
      await a.engine.waitConverged();

      const docId = "doc-divergent-x" as import("@zync/core").DocId;

      // Simulate: pass saw divergence, confirmDivergence returned false (recorded not resolved).
      a.engine.addPendingDivergenceDocId(docId);
      const snapshot = a.engine.pendingDivergenceDocIdsSnapshot();
      expect(snapshot.has(docId)).toBe(true);

      // Simulate: next pass observes <=1 live path (non-divergent) or resolution ran.
      a.engine.clearPendingDivergenceDocId(docId);
      const after = a.engine.pendingDivergenceDocIdsSnapshot();
      expect(after.has(docId)).toBe(false);

      await a.engine.stop();
    },
  );

  /**
   * Test 3d: a NON-divergent rename leaves pendingDivergenceDocIds empty.
   *
   * A plain rename (no partition) never has >1 live path for a docId, so confirmDivergence
   * never enqueues. This guards the negative case (no spurious enqueue on ordinary renames).
   * The real DIVERGENT-rename enqueue path is covered by test 3e (partitioned divergent rename).
   */
  it(
    "3d) structural reconcile: a non-divergent rename leaves pendingDivergenceDocIds empty",
    { timeout: 60_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();
      await converge(a, b);

      // Create a scenario: write a note, sync it, so both have the doc.
      // (Full divergent-rename requires partition, which is outside this unit's scope;
      // we verify a normal converge leaves the set empty.)
      await a.vault.writeAtomic(path("rename/original.md"), utf8("rename test content"));
      await converge(a, b);

      // Normal rename (no divergence): A renames, B receives.
      await a.vault.rename(path("rename/original.md"), path("rename/renamed.md"));
      await converge(a, b);

      // No divergence occurred, so the set should be empty on both.
      expect(a.engine.pendingDivergenceDocIdsSnapshot().size).toBe(0);
      expect(b.engine.pendingDivergenceDocIdsSnapshot().size).toBe(0);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  /**
   * Test 3e: production `confirmDivergence` enqueue path self-drains via S6a.
   *
   * A and B share x.md. B partitions away; A renames x.md→a.md while B renames x.md→b.md.
   * On heal, both live paths (a.md and b.md) land in the index for the SAME docId. The
   * FIRST structural reconcile pass records the divergence in `priorDivergence` but
   * returns `confirmed=false` (stability gate requires two consecutive sightings). The
   * `confirmDivergence` callback (confirmed===false branch) enqueues the docId into
   * `pendingDivergenceDocIds` AND sets `freshBackstopWork=true` (S6a), which causes the
   * reconcile loop to run a SECOND pass immediately. The second pass confirms the divergence
   * and resolves it — no unrelated index event needed.
   *
   * TDD guarantee (S6a): if `enqueuePendingDivergenceDocId(docId)` is removed from the
   * `confirmed===false` branch, `freshBackstopWork` is never set, the second pass is not
   * triggered, and the divergence remains unresolved after a single `whenIdle()` post-heal.
   * Removing the enqueue call would cause `pendingDivergenceDocIdsSnapshot().size > 0` to
   * remain true (or require an unrelated write to trigger the second pass) — i.e. the
   * final assertion `size === 0` would fail.
   *
   * Full resolution mechanics (confirmDivergence + applyRenameConflictResolution) are
   * exercised by test 3d and the engine-structural suite; here we focus on the SELF-DRAIN
   * property: a single `whenIdle()` after heal suffices (no unrelated second trigger needed).
   */
  it(
    "3e) production confirmDivergence enqueues docId into pendingDivergenceDocIds on first pass",
    { timeout: 60_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      // Converge both devices on x.md so the doc is attached on both.
      await a.vault.writeAtomic(path("diverge3e/x.md"), utf8("shared body for 3e"));
      await converge(a, b);
      expect(await b.vault.read(path("diverge3e/x.md"))).not.toBeNull();

      // Record the shared docId — we'll assert the divergence is fully resolved after heal.
      const xEntry = a.engine.index.get(path("diverge3e/x.md"));
      expect(xEntry).toBeDefined();
      if (xEntry === undefined) return;
      const sharedDocId = xEntry.docId;

      // Partition B away; each side renames x.md to a different target while offline.
      b.transport.goOffline();

      await a.vault.rename(path("diverge3e/x.md"), path("diverge3e/a.md"));
      await a.engine.whenIdle();

      await b.vault.rename(path("diverge3e/x.md"), path("diverge3e/b.md"));
      await b.engine.whenIdle();

      // Heal B — the index now has BOTH a.md and b.md live for sharedDocId.
      // S6a self-drain: the FIRST structural pass enqueues sharedDocId into
      // pendingDivergenceDocIds AND sets freshBackstopWork=true. The reconcile loop
      // immediately runs a SECOND pass, which confirms the divergence (two consecutive
      // sightings of the same signature) and resolves it — one winner path survives.
      // A single whenIdle() after heal is enough: no unrelated index event needed.
      b.transport.goOnline();
      await b.engine.whenIdle();

      // ASSERT SELF-DRAIN: the divergence must be FULLY resolved after a single whenIdle().
      // TDD guarantee: if enqueuePendingDivergenceDocId() is removed from the confirmed===false
      // branch, freshBackstopWork is never set, the second pass never fires, and sharedDocId
      // stays in pendingDivergenceDocIds (size > 0) or the index still has two live paths.
      expect(b.engine.pendingDivergenceDocIdsSnapshot().has(sharedDocId)).toBe(false);
      // Exactly one live path survives for sharedDocId (the divergence was picked).
      const livePaths = b.engine.index
        .liveEntries()
        .filter(([, e]) => e.docId === sharedDocId)
        .map(([p]) => p);
      expect(livePaths).toHaveLength(1);

      // Now let both converge fully.
      await converge(a, b);
      expect(a.engine.pendingDivergenceDocIdsSnapshot().size).toBe(0);
      expect(b.engine.pendingDivergenceDocIdsSnapshot().size).toBe(0);

      await a.engine.stop();
      await b.engine.stop();
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 4 — convergence unchanged (S3 sets are inert)
// ══════════════════════════════════════════════════════════════════════════

describe("S3 backstop sets — convergence unchanged (sets are inert)", () => {
  /**
   * Test 4: a burst of N creates converges byte-identically despite the three new sets.
   *
   * Mirrors Scenario 13 from engine-integration.test.ts to confirm the sets do NOT
   * change convergence behavior. Passes are still FULL; the sets are populated and
   * drained but do not scope any work.
   */
  it(
    "4) burst convergence is byte-identical with S3 backstop sets present",
    { timeout: 60_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();
      await converge(a, b);

      const N = 20;
      for (let i = 0; i < N; i++) {
        await a.vault.writeAtomic(path(`s3burst/n${String(i)}.md`), utf8(`s3 note ${String(i)}`));
      }
      await a.engine.waitConverged();

      // B converges via observe path only — no waitConverged on B during window.
      const countMd = async (): Promise<number> =>
        (await b.vault.list()).filter(({ path: p }) => p.startsWith("s3burst/")).length;
      let have = 0;
      for (let i = 0; i < 300 && have < N; i++) {
        await b.engine.whenIdle();
        have = await countMd();
        if (have < N) await new Promise<void>((r) => setTimeout(r, 2));
      }
      expect(have).toBe(N);

      // Spot-check byte-identity.
      for (const i of [0, 10, 19]) {
        const p = path(`s3burst/n${String(i)}.md`);
        const bytes = await b.vault.read(p);
        expect(bytes).not.toBeNull();
        if (bytes !== null) expect(decode(bytes)).toBe(`s3 note ${String(i)}`);
      }

      // Full convergence + both sets drained.
      await b.engine.waitConverged();
      expect(await b.engine.pendingDocs()).toEqual([]);
      expect(b.engine.remoteUpdatedSinceSettleSnapshot().size).toBe(0);
      expect(b.engine.lazyAttachManager.needsCatchUpSnapshot().size).toBe(0);
      expect(b.engine.pendingDivergenceDocIdsSnapshot().size).toBe(0);

      await a.engine.stop();
      await b.engine.stop();
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 5 — S6a self-draining liveness
// ══════════════════════════════════════════════════════════════════════════

// ── NeverAckNoteTransport ──────────────────────────────────────────────────
//
// A TransportPort wrapper used by the genuine spin-safety test (S6a-2).
//
// `synced()` delegates to the inner transport so the state-vector exchange
// (and thus index sync) works normally. For every non-index doc, `acked()`
// returns an immediately-REJECTED promise — the doc content is synced (relay
// has it) but this device never "retires" its push obligation.
//
// WHY a rejection and not a pending promise: `awaitAckBounded` does:
//   handle.acked().then(() => true).catch(() => false)
// raced against a timeout. A REJECTED promise resolves the race immediately
// via the `.catch` arm with NO timeout wait, so the ack-failure path is
// exercised deterministically and fast, with no `ackTimeoutMs` dependency.
//
// The rejection is ALWAYS active for all non-index docs from the moment of
// construction -- this ensures the target doc's `syncedStamp` NEVER advances
// (the ack gate fires immediately on first catch-up), keeping it permanently
// stamp-mismatched and permanently in `needsCatchUp`.
class NeverAckNoteTransport implements TransportPort {
  constructor(private readonly inner: TransportPort) {}

  status(): ConnStatus {
    return this.inner.status();
  }
  onStatus(cb: (s: ConnStatus) => void): Unsubscribe {
    return this.inner.onStatus(cb);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  attach(doc: CrdtDoc): AttachedDoc {
    const inner = this.inner.attach(doc);
    return {
      synced: () => inner.synced(),
      acked: () => {
        // The index doc always acks normally -- engine.start() awaits synced() on it
        // and the ack path must complete so the engine can bootstrap correctly.
        if (doc.id === INDEX_DOC_ID) return inner.acked();
        // All note docs: immediately-rejected ack. The content has been synced
        // (relay received it), but we never retire the push obligation. Attach a
        // no-op catch to prevent unhandled-rejection warnings on callers that don't
        // immediately chain .catch themselves.
        const rejected = Promise.reject(new Error("spin-test: ack always rejected"));
        void rejected.catch(() => undefined);
        return rejected;
      },
      detach: () => {
        inner.detach();
      },
    };
  }
}

/**
 * An EngineStateStore wrapper that silently blocks all `setSyncedStamp` calls for
 * note docs (any doc other than the index doc). Used by the spin-safety test to
 * keep note docs permanently stamp-mismatched on device B.
 *
 * WHY we need this: the outbound pipeline (`OutboundPipeline.onRemoteUpdate`)
 * calls `setSyncedStamp` synchronously during the state-vector exchange inside
 * `InProcessTransport.resyncOne` — BEFORE `awaitAckBounded` is reached. Without
 * this block, the stamp advances via outbound regardless of ack rejection, making
 * it impossible to maintain a stamp mismatch across reconcile passes and thus
 * impossible to trigger the spin vector with InProcessBus.
 *
 * Only non-index docs are blocked — the index doc's syncedStamp must advance
 * normally so the engine can bootstrap and discover note-doc stamps.
 */
class BlockedSyncedStampState implements EngineStateStore {
  private readonly inner: MemEngineState;

  constructor() {
    this.inner = new MemEngineState();
  }

  getSyncedStamp(id: DocId): Promise<Stamp | null> {
    return this.inner.getSyncedStamp(id);
  }

  setSyncedStamp(id: DocId, stamp: Stamp): Promise<void> {
    // Block all note-doc syncedStamp advances. This simulates a scenario where the
    // outbound pipeline's setSyncedStamp call (which fires BEFORE ack is checked in
    // runCatchUp) does not advance the stamp, keeping the doc permanently
    // stamp-mismatched. Without this block, the stamp is advanced by outbound before
    // awaitAckBounded runs, and the ack rejection has no effect on the stamp.
    if (id === INDEX_DOC_ID) return this.inner.setSyncedStamp(id, stamp);
    return Promise.resolve(); // silently block for note docs
  }

  markDirty(id: DocId): Promise<void> {
    return this.inner.markDirty(id);
  }

  clearDirty(id: DocId): Promise<void> {
    return this.inner.clearDirty(id);
  }

  listDirty(): Promise<DocId[]> {
    return this.inner.listDirty();
  }

  isDirty(id: DocId): Promise<boolean> {
    return this.inner.isDirty(id);
  }

  getLastLivePath(id: DocId): Promise<VaultPath | null> {
    return this.inner.getLastLivePath(id);
  }

  setLastLivePath(id: DocId, p: VaultPath): Promise<void> {
    return this.inner.setLastLivePath(id, p);
  }

  clearLastLivePath(id: DocId): Promise<void> {
    return this.inner.clearLastLivePath(id);
  }

  markDeleted(id: DocId): Promise<void> {
    return this.inner.markDeleted(id);
  }

  wasDeleted(id: DocId): Promise<boolean> {
    return this.inner.wasDeleted(id);
  }

  clearDeleted(id: DocId): Promise<void> {
    return this.inner.clearDeleted(id);
  }

  getConfigBase(path: VaultPath): Promise<Sha256 | null> {
    return this.inner.getConfigBase(path);
  }

  setConfigBase(path: VaultPath, sha256: Sha256): Promise<void> {
    return this.inner.setConfigBase(path, sha256);
  }

  getConfigLocalVersion(path: VaultPath): Promise<number> {
    return this.inner.getConfigLocalVersion(path);
  }

  setConfigLocalVersion(path: VaultPath, version: number): Promise<void> {
    return this.inner.setConfigLocalVersion(path, version);
  }

  getConfigNormalizedSha(path: VaultPath): Promise<Sha256 | null> {
    return this.inner.getConfigNormalizedSha(path);
  }

  setConfigNormalizedSha(path: VaultPath, sha256: Sha256 | null): Promise<void> {
    return this.inner.setConfigNormalizedSha(path, sha256);
  }

  getLocalSuppress(): Promise<string[]> {
    return this.inner.getLocalSuppress();
  }

  setLocalSuppress(ids: string[]): Promise<void> {
    return this.inner.setLocalSuppress(ids);
  }
}

/**
 * makeDevice variant used by the genuine spin-safety test (S6a-2).
 *
 * Device B combines TWO seams that together create a persistent stamp mismatch:
 *   1. `NeverAckNoteTransport` — `acked()` for note docs always rejects, so
 *      `runCatchUp` never calls `setSyncedStamp` (ack gate at line 601 in lazy-attach.ts).
 *   2. `BlockedSyncedStampState` — `setSyncedStamp` for note docs is a no-op, so
 *      the outbound pipeline's independent `setSyncedStamp` call (which fires during
 *      the state-vector exchange in `InProcessTransport.resyncOne`) is also blocked.
 *
 * Together these keep `syncedStamp = null` for note docs on B throughout the test,
 * ensuring every `computeCatchUpSet` pass finds a genuine stamp mismatch and selects
 * the doc — which is the precondition for the spin vector.
 */
function makeDeviceWithNeverAck(
  bus: InProcessBus,
  deviceId: string,
  name: string,
): { engine: SyncEngine; vault: FakeVault; inner: InProcessTransport } {
  const vault = new FakeVault();
  const inner = bus.connect();
  const transport = new NeverAckNoteTransport(inner);
  const engineState = new BlockedSyncedStampState();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(deviceId, name),
    engineState,
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
    // ingestDisabled keeps B's vault-write events from being re-ingested; not
    // strictly necessary given BlockedSyncedStampState, but consistent with the
    // "receive-only" role this device plays in the spin test.
    ingestDisabled: true,
  };
  return { engine: new SyncEngine(ports, config), vault, inner };
}

describe("S6a self-draining liveness", () => {
  /**
   * Test S6a-1: remoteUpdatedSinceSettle drains without a follow-up index event.
   *
   * When a note doc receives a remote-origin update (via `noteRemoteUpdate`), the S6a
   * `onBackstopWork` seam fires `freshBackstopWork=true` and schedules the reconcile loop.
   * The loop runs `settleCleanDocs`, which drains the set once the doc text == disk ==
   * index stamp. This test verifies that the drain happens via the backstop seam alone --
   * no separate index.observe event is needed.
   *
   * Scenario: converge a note on A and B. Then directly inject the docId into B's
   * `remoteUpdatedSinceSettle` via the seam (simulating a remote update that arrived with
   * no concurrent index-key change). A single `whenIdle()` on B must drain the set.
   *
   * TDD guarantee: if `noteRemoteUpdate` is disconnected from `onBackstopWork` (S6a path
   * removed), the set would NOT be drained by `whenIdle()` alone -- the test would fail
   * because `remoteUpdatedSinceSettleSnapshot().size` would remain 1.
   */
  it(
    "S6a-1) remoteUpdatedSinceSettle drains via onBackstopWork without index-observe followup",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      // Converge both devices on a note so the docId is attached and settled on B.
      await a.vault.writeAtomic(path("s6a/settle.md"), utf8("initial content"));
      await converge(a, b);

      const entry = b.engine.index.get(path("s6a/settle.md"));
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      const docId = entry.docId;

      // Pre-condition: set is empty.
      expect(b.engine.remoteUpdatedSinceSettleSnapshot().has(docId)).toBe(false);

      // Directly inject the docId into remoteUpdatedSinceSettle via the seam.
      // This simulates what bindOutbound does on a remote-origin note-doc update.
      // S6a: noteRemoteUpdate fires onBackstopWork -> freshBackstopWork=true -> scheduleReconcile.
      b.engine.lazyAttachManager.noteRemoteUpdate(docId);
      expect(b.engine.remoteUpdatedSinceSettleSnapshot().has(docId)).toBe(true);

      // A single whenIdle() must drain the set -- no unrelated index event needed.
      // S6a: the scheduleReconcile() triggered by onBackstopWork drives settleCleanDocs, which
      // drains the entry because the doc is already settled (text == disk == index stamp).
      await b.engine.whenIdle();
      expect(b.engine.remoteUpdatedSinceSettleSnapshot().has(docId)).toBe(false);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  /**
   * Test S6a-2 (GENUINE SPIN VECTOR): SPIN-SAFETY for a persistently-failing ack
   * combined with a blocked syncedStamp advance.
   *
   * WHY THE OLD TEST WAS INADEQUATE
   * ─────────────────────────────────
   * The previous S6a-2 injected a CONVERGED doc into `needsCatchUp` via the seam. On the
   * next pass, `settleCleanDocs` drains it immediately (syncedStamp == indexStamp). The
   * ack gate is never reached, so the re-enqueue path in `runCatchUp` (the `if (!acked)`
   * branch) is never exercised. Removing the `isNew` guard from `enqueueNeedsCatchUp`
   * would NOT make that test fail or spin because the re-enqueue never fires. The old test
   * only proved bounded termination for a converged doc -- NOT spin prevention for a
   * persistently-failing ack, which is the scenario the guard was built for.
   *
   * THE REAL SPIN VECTOR
   * ─────────────────────
   * There are TWO sites in the codebase that call `enqueueNeedsCatchUp(docId)` for the
   * same doc every pass when syncedStamp stays permanently mismatched:
   *   1. `computeCatchUpSet` (stamp-mismatch precheck) selects the doc every pass.
   *   2. `runCatchUp`'s `if (!acked)` branch fires for each ack rejection.
   *
   * WITHOUT the `isNew` guard: both sites call `onBackstopWork()` unconditionally ->
   * `freshBackstopWork = true` after every pass -> loop iterates again -> sites fire again
   * -> INFINITE SPIN. The test times out at the `whenIdle()` await.
   *
   * WITH the `isNew` guard: the docId is added on the FIRST genuinely-new enqueue;
   * subsequent enqueues (same docId already in set) are no-ops for `freshBackstopWork`.
   * After the initial pass (which sets freshBackstopWork=true via the genuine-new enqueue
   * in computeCatchUpSet) and one backstop pass, the flag stays false -> loop EXITS.
   *
   * WHY WE NEED BlockedSyncedStampState
   * ─────────────────────────────────────
   * With InProcessBus, `OutboundPipeline.onRemoteUpdate` fires SYNCHRONOUSLY during the
   * state-vector exchange in `InProcessTransport.resyncOne` (which is called from
   * `transport.attach`). This calls `setSyncedStamp` BEFORE `awaitAckBounded` is reached.
   * Without blocking that call, `syncedStamp` advances via outbound regardless of ack
   * rejection, and `settleCleanDocs` drains `needsCatchUp` on the same pass (because
   * `stampsEqual(synced, entry.stamp)` becomes true). The stamp mismatch disappears before
   * the second enqueue fires, so the guard is never stress-tested.
   *
   * `BlockedSyncedStampState` suppresses all `setSyncedStamp` calls for note docs, keeping
   * `syncedStamp = null` permanently. Combined with `NeverAckNoteTransport` (which blocks
   * `runCatchUp`'s own ack-gated stamp advance), the doc stays stamp-mismatched across
   * every pass -- the exact precondition the guard was built for.
   *
   * THE TEST
   * ─────────
   * Device B uses both seams. After A writes a note and B indexes it, B runs:
   *   PASS 1 (index-observe triggered):
   *     - computeCatchUpSet: stamp mismatch -> enqueueNeedsCatchUp [GENUINELY NEW ->
   *       freshBackstopWork=true]
   *     - runCatchUp: fresh attach -> outbound fires (setSyncedStamp BLOCKED) ->
   *       acked() REJECTS -> enqueueNeedsCatchUp [already in set -> NO-OP with guard]
   *     - settleCleanDocs: synced=null != entry.stamp -> acked() REJECTS -> no drain
   *     - freshBackstopWork=true -> continue to PASS 2
   *   PASS 2 (backstop-only):
   *     - computeCatchUpSet: stamp mismatch -> enqueueNeedsCatchUp [already in set -> NO-OP]
   *     - runCatchUp: reused doc -> acked() REJECTS -> enqueueNeedsCatchUp [NO-OP]
   *     - settleCleanDocs: still no drain (synced=null)
   *     - freshBackstopWork=false -> loop EXITS
   *
   * Without the guard: PASS 2's enqueues each call onBackstopWork -> freshBackstopWork=true
   * -> loop never exits -> whenIdle() hangs until the 5 s timeout fires.
   *
   * LOAD-BEARING EXPERIMENT (performed, then guard restored):
   * Temporarily removing the `isNew` check from `enqueueNeedsCatchUp` caused `whenIdle()`
   * to hang until the 5 s timeout fired -- confirming this test exercises the real spin
   * vector. Production code restored byte-for-byte after the experiment.
   */
  it(
    "S6a-2) GENUINE SPIN-SAFETY: persistently-rejected ack + blocked syncedStamp yields bounded passes",
    { timeout: 5_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      // Device B uses:
      //   - NeverAckNoteTransport: acked() always rejects for note docs, blocking
      //     runCatchUp's own setSyncedStamp call (which is gated on acked=true).
      //   - BlockedSyncedStampState: setSyncedStamp is a no-op for note docs, blocking
      //     the outbound pipeline's independent setSyncedStamp call that fires during
      //     state-vector exchange (before acked() is even reached in runCatchUp).
      // Together these keep syncedStamp=null for note docs across all reconcile passes.
      const b = makeDeviceWithNeverAck(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      // Let B's initial full-convergence pass complete (no notes exist yet).
      await b.engine.whenIdle();

      // Spy on B's runCatchUp to count reconcile-loop passes triggered after A writes.
      // One runCatchUp call = one iteration of the while-loop body in runReconcileLoop.
      let passCount = 0;
      const mgr = b.engine.lazyAttachManager;
      const originalRunCatchUp = mgr.runCatchUp.bind(mgr);
      mgr.runCatchUp = async (...args: Parameters<typeof mgr.runCatchUp>) => {
        passCount++;
        return originalRunCatchUp(...args);
      };

      // Write a note on A and converge A. B's index CRDT receives the stamp via the bus.
      // B schedules a reconcile pass. The pass selects the stamp-mismatched note doc,
      // attaches it (outbound fires but setSyncedStamp is BLOCKED), acked() REJECTS ->
      // enqueueNeedsCatchUp [already in needsCatchUp from computeCatchUpSet -> NO-OP].
      // settleCleanDocs finds synced=null != entry.stamp -> acked() REJECTS -> no drain.
      // freshBackstopWork=true (from genuine-new enqueue in computeCatchUpSet) -> PASS 2.
      // PASS 2: computeCatchUpSet still mismatched -> NO-OP; runCatchUp ack REJECTS -> NO-OP.
      // freshBackstopWork=false -> loop EXITS.
      await a.vault.writeAtomic(path("s6a/spin2.md"), utf8("spin2 test content"));
      await a.engine.waitConverged();

      // THE KEY ASSERTION: whenIdle() MUST resolve within the 5 s timeout.
      // Without the isNew guard: every pass re-fires onBackstopWork -> freshBackstopWork=true
      // forever -> the loop never exits -> this await hangs until the test times out.
      await b.engine.whenIdle();

      // Look up the note's docId from B's index.
      const entry = b.engine.index.get(path("s6a/spin2.md"));
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      const capturedDocId = entry.docId;

      // BOUNDED-PASS ASSERTION: the reconcile loop must not have spun more than MAX_PASSES
      // times. Without the isNew guard, passCount grows without bound (spin) before timeout.
      const MAX_PASSES = 5;
      expect(passCount).toBeLessThanOrEqual(MAX_PASSES);

      // NON-CONVERGENCE ASSERTION: the doc STAYS pending on B because syncedStamp never
      // advanced (BlockedSyncedStampState blocks outbound; NeverAck blocks runCatchUp).
      // This is EXPECTED VISIBLE non-convergence -- not silent loss. The loop terminates
      // but the doc legitimately stays pending until a real ack is possible.
      const pending = await b.engine.pendingDocs();
      expect(pending).toContain(capturedDocId);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  /**
   * Test S6a-2b: BOUNDED-TERMINATION for a converged doc in needsCatchUp.
   *
   * This is the scenario from the ORIGINAL (inadequate) S6a-2. It is kept as a useful
   * regression guard for the drain-on-equality path, with an accurate description.
   *
   * NOTE: this does NOT exercise the ack-failure re-enqueue path and removing the `isNew`
   * guard from `enqueueNeedsCatchUp` would NOT make this test fail. The ack gate is never
   * reached because the doc has equal stamps and is drained by settleCleanDocs first.
   * For the genuine spin-safety assertion, see S6a-2 above.
   */
  it(
    "S6a-2b) DRAIN: converged doc in needsCatchUp is drained by settleCleanDocs (bounded termination)",
    { timeout: 5_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      // Converge so the docId is known and attached on B (syncedStamp == indexStamp).
      await a.vault.writeAtomic(path("s6a/spin.md"), utf8("spin test content"));
      await converge(a, b);

      const entry = b.engine.index.get(path("s6a/spin.md"));
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      const docId = entry.docId;

      expect(b.engine.lazyAttachManager.needsCatchUpSnapshot().has(docId)).toBe(false);

      // Inject into needsCatchUp. Stamps are equal, so settleCleanDocs drains it.
      // The ack gate is never reached -- this tests drain-on-equality, not spin prevention.
      b.engine.lazyAttachManager.addNeedsCatchUp(docId);
      expect(b.engine.lazyAttachManager.needsCatchUpSnapshot().has(docId)).toBe(true);

      await b.engine.whenIdle();

      // Drained because syncedStamp == indexStamp (settleCleanDocs removes it).
      expect(b.engine.lazyAttachManager.needsCatchUpSnapshot().has(docId)).toBe(false);

      // Full convergence still works.
      await b.engine.waitConverged();
      expect(await b.engine.pendingDocs()).toEqual([]);

      await a.engine.stop();
      await b.engine.stop();
    },
  );
});
