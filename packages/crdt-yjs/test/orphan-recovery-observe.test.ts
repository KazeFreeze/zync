/**
 * S7 — orphan-recovery-after-observe-collision
 *
 * Proves the S7 invariant: the scoped hot path (observe-driven
 * runObserveScopedReconcile) does NOT run orphan sweep, while a FULL pass
 * (runFullConvergencePass — triggered here by the S6c quiescence audit) DOES.
 *
 * Collision setup:
 *   A and B each create the SAME vault path while partitioned (A offline), then
 *   heal. The index tree LWW binds the path to one winner docId; the LOSER docId
 *   remains in the loser device's docStore as an orphan.
 *
 * Assertion (a): immediately after the scoped observe path settles (whenIdle,
 *   NOT waitConverged), the loser is NOT yet recovered — no conflict artifact in
 *   the index tree. This proves the scoped hot path skips the orphan sweep.
 *
 * Assertion (b): after a FULL audit fires (fake timers advanced past
 *   AUDIT_QUIESCENCE_MS), the loser IS recovered to a deterministic conflict path.
 *   This proves the full pass (S6c quiescence audit → runFullConvergencePass →
 *   runOrphanSweep) recovers the loser.
 *
 * Load-bearing: the test fails if runOrphanSweep is removed from the full path
 * entirely (assertion (b) would fail — no conflict artifact appears), confirming
 * the sweep is genuinely load-bearing in full passes.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig, AUDIT_QUIESCENCE_MS } from "@zync/core";
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

// ── helpers ────────────────────────────────────────────────────────────────

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const DAILY = path("daily/2026-06-20.md");
const A_BODY = "A's offline note content\n";
const B_BODY = "B's offline note content\n";

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
  transport: InProcessTransport;
}

function makeDevice(bus: InProcessBus, deviceId: string): Device {
  const vault = new FakeVault();
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(deviceId),
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

/** Return the live paths in an engine's index tree. */
function livePaths(e: SyncEngine): string[] {
  return e.index
    .liveEntries()
    .map(([p]) => p)
    .sort();
}

/** Return any paths that look like orphan conflict artifacts. */
function conflictPaths(e: SyncEngine): string[] {
  return livePaths(e).filter((p) => p.includes("(conflict,"));
}

// ── suite ──────────────────────────────────────────────────────────────────

describe("S7: orphan-recovery-after-observe-collision", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "scoped hot path skips orphan sweep; S6c quiescence audit (full pass) recovers the loser",
    { timeout: 20_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const a = makeDevice(bus, "dev-a");
        const b = makeDevice(bus, "dev-b");

        // Start both engines and let the startup full pass settle.
        await a.engine.start();
        await b.engine.start();
        // Ensure startup converges so both see an empty, consistent index.
        await a.engine.whenIdle();
        await b.engine.whenIdle();

        // Partition A: A goes offline so the two creates are independent.
        a.transport.goOffline();

        // Both devices independently create the SAME path with DIFFERENT content.
        // These flow through the watcher → ingest path (after-start creates), so
        // each device mints its own docId + writes create-meta + docStore snapshot.
        await a.vault.writeAtomic(DAILY, utf8(A_BODY));
        await b.vault.writeAtomic(DAILY, utf8(B_BODY));

        // Drain each side's observe-driven scoped passes offline.
        await a.engine.whenIdle();
        await b.engine.whenIdle();

        // ── Heal A: let the observe-driven scoped passes settle (no full pass). ──
        //
        // goOnline() reconnects transport so index/doc updates flow between engines.
        // We deliberately use whenIdle() (NOT waitConverged()) so only scoped passes
        // run — the goal of assertion (a) is that the orphan is NOT recovered yet.
        a.transport.goOnline();

        // Give the observe loop several rounds to exchange index updates and docs.
        // Run multiple whenIdle cycles to let cross-device replication settle as
        // much as possible without triggering a full convergence pass.
        for (let i = 0; i < 8; i++) {
          await a.engine.whenIdle();
          await b.engine.whenIdle();
        }

        // ── Assertion (a): scoped pass does NOT recover the orphan. ──
        //
        // After the observe path settled (no full pass called), the index should
        // have EXACTLY ONE live path for DAILY (the LWW winner). No conflict artifact
        // must appear, proving the scoped hot path correctly skipped runOrphanSweep.
        // The winner device has the live path; the loser device may still have the
        // old local binding. Either way, no "(conflict," path should exist yet.
        const conflictsBeforeAudit = [...conflictPaths(a.engine), ...conflictPaths(b.engine)];
        expect(conflictsBeforeAudit).toHaveLength(0);

        // ── Trigger S6c quiescence audit → runFullConvergencePass → runOrphanSweep ──
        //
        // Advance fake time past AUDIT_QUIESCENCE_MS so the quiescence timer fires
        // on both engines, scheduling a runFullConvergencePass iteration in each
        // engine's reconcile loop. vi.advanceTimersByTimeAsync flushes microtasks
        // between each tick step so the timer callback + loop iteration complete.
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 200);

        // Drain the audit iteration on both engines.
        await a.engine.whenIdle();
        await b.engine.whenIdle();

        // ── Assertion (b): full pass DID recover the loser. ──
        //
        // After the full pass ran runOrphanSweep, the loser's docId should have been
        // recovered to a deterministic "(conflict, <createdBy>, <createdTs>)" path.
        // At least ONE of the two engines must show a conflict artifact (the OWNER of
        // the losing docStore snapshot is the one that materializes the recovery; the
        // other device sees the recovery via normal CRDT replication, which may need
        // an additional full pass to propagate — so we check the owning engine only
        // needs to show it, and then let both converge for the final check).
        const conflictsA = conflictPaths(a.engine);
        const conflictsB = conflictPaths(b.engine);
        const totalConflicts = conflictsA.length + conflictsB.length;
        expect(totalConflicts).toBeGreaterThanOrEqual(1);

        // The recovered path should contain "(conflict," per the orphan-sweep contract.
        const allConflicts = [...conflictsA, ...conflictsB];
        for (const cp of allConflicts) {
          expect(cp).toContain("(conflict,");
        }

        // Both devices still quiescent on the live file — the collision winner's path
        // is still bound (no double-write or loss of the winning content).
        const aLive = await a.vault.read(DAILY);
        const bLive = await b.vault.read(DAILY);
        // Winner side should have the file; at minimum the globally bound path exists.
        const someLiveContent =
          aLive !== null ? decode(aLive) : bLive !== null ? decode(bLive) : null;
        expect(someLiveContent).not.toBeNull();
        if (someLiveContent !== null) {
          expect(someLiveContent === A_BODY || someLiveContent === B_BODY).toBe(true);
        }

        // ── Load-bearing confirmation ──
        //
        // This test would FAIL if runOrphanSweep were removed from runFullConvergencePass
        // (assertion (b) above: totalConflicts >= 1 would fail because no sweep ever runs
        // the orphan recovery on a full pass). Only the in-scope scoped path is skipped;
        // the full path MUST still call it.

        await a.engine.stop();
        await b.engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
