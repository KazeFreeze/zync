/**
 * S7 — orphan-recovery-after-observe-collision
 *
 * Proves that after a genuine offline→connected heal, the LWW-loser orphan is
 * recovered to a deterministic conflict artifact via a FULL pass' orphan sweep
 * (runFullConvergencePass → runOrphanSweep).
 *
 * Collision setup:
 *   A and B each create the SAME vault path while partitioned (A offline), then
 *   heal via a.transport.goOnline(). The index tree LWW binds the path to one
 *   winner docId; the LOSER docId remains in the loser device's docStore as an
 *   orphan.
 *
 * Recovery path: on reconnect, pending is still non-empty (the loser docId is
 * still dirty), so the pending-gated reconnect self-heal arms and runs a full
 * pass (structuralReconcile → runOrphanSweep) — recovering the loser AT/BY the
 * reconnect. Belt-and-suspenders: the later S6c quiescence audit runs the SAME
 * orphan sweep, so whichever fires, the outcome holds. This test therefore
 * asserts OUTCOMES, not the recovery SCHEDULE:
 *   - at least one conflict artifact surfaces across the two engines;
 *   - the loser is recovered EXACTLY once per device (no duplicate artifacts);
 *   - every recovered path is a deterministic "(conflict, …)" artifact;
 *   - the winning content is intact (no loss).
 *
 * The reconnect self-heal jitter is set to 0 (reconnectHealJitterMaxMs) so the
 * arm fires immediately — required for a clean fake-timer test.
 *
 * Load-bearing: the test fails if runOrphanSweep is removed from the full path
 * entirely (the recovered assertion would fail — no conflict artifact appears),
 * confirming the sweep is genuinely load-bearing in full passes.
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
    // Make the pending-gated reconnect self-heal fire immediately (no jitter
    // setTimeout to advance) so this fake-timer test is deterministic.
    reconnectHealJitterMaxMs: 0,
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
    "reconnect-armed self-heal (full pass → orphan sweep) recovers the collision loser to a conflict artifact — asserts outcomes, not schedule",
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

        // ── Heal A: genuine offline→connected reconnect. ──
        //
        // goOnline() reconnects transport so index/doc updates flow between engines.
        // Because the loser docId is still pending after catch-up, the pending-gated
        // reconnect self-heal arms (jitter=0 → immediate) and runs a full pass
        // (structuralReconcile → runOrphanSweep), recovering the loser AT/BY the
        // reconnect.
        a.transport.goOnline();

        // ── Settle the engines so the orphan sweep runs to completion. ──
        //
        // Belt-and-suspenders: both the reconnect self-heal AND the later S6c
        // quiescence audit run the SAME orphan sweep — whichever fires, the outcome
        // holds. Drive several whenIdle rounds (to let the reconnect-armed full pass
        // and cross-device replication settle), then advance past AUDIT_QUIESCENCE_MS
        // (fallback: the spec allows "recovered BY the audit, not necessarily AT it"),
        // then a few more whenIdle rounds to drain the audit iteration.
        for (let i = 0; i < 8; i++) {
          await a.engine.whenIdle();
          await b.engine.whenIdle();
        }
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 200);
        for (let i = 0; i < 4; i++) {
          await a.engine.whenIdle();
          await b.engine.whenIdle();
        }

        // The reconnect self-heal (pending-gated, jitter=0) runs the full pass → runOrphanSweep recovers
        // the LWW-loser orphan. Assert OUTCOMES, not the old schedule: recovered exactly once, a conflict
        // artifact surfaced, winning content intact (no loss).
        const conflictsA = conflictPaths(a.engine);
        const conflictsB = conflictPaths(b.engine);
        const allConflicts = [...conflictsA, ...conflictsB];
        expect(allConflicts.length).toBeGreaterThanOrEqual(1);
        // Recovered EXACTLY once: the single LWW-loser must produce exactly ONE DISTINCT conflict path
        // across both devices (the peer replicates the SAME deterministic "(conflict, createdBy,
        // createdTs)" path — so a duplicate/re-recovery would surface as a 2nd distinct path here).
        // (Per-device `Set(conflictsA).size === length` is vacuous — conflictPaths derives from the
        // path→docId index map, whose keys are unique by construction; the cross-device DISTINCT count
        // is the meaningful "recovered once" guard.)
        expect(new Set(allConflicts).size).toBe(1);
        for (const cp of allConflicts) expect(cp).toContain("(conflict,");

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
        // (the recovered assertion above: allConflicts.length >= 1 would fail because no
        // sweep ever runs the orphan recovery on a full pass). The full path MUST call it.

        await a.engine.stop();
        await b.engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "IDENTICAL content on both sides is a no-op: the loser is NOT recovered into a duplicate",
    { timeout: 20_000 },
    async () => {
      // REGRESSION (real vault, 2026-08-03): a phone whose index had not loaded re-seeded an
      // ALREADY-SYNCED vault, so ~190 losers were orphaned at once. Every one held byte-identical
      // content to its winner, yet the sweep "recovered" each into a "(conflict, …)" duplicate of a
      // real note. Identical content is not a conflict: the winner already has exactly these bytes,
      // so there is nothing to rescue and a copy is pure pollution.
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const a = makeDevice(bus, "dev-a");
        const b = makeDevice(bus, "dev-b");

        await a.engine.start();
        await b.engine.start();
        await a.engine.whenIdle();
        await b.engine.whenIdle();

        a.transport.goOffline();

        // Same path, SAME bytes on both sides (the whole-vault re-seed signature).
        await a.vault.writeAtomic(DAILY, utf8(A_BODY));
        await b.vault.writeAtomic(DAILY, utf8(A_BODY));

        await a.engine.whenIdle();
        await b.engine.whenIdle();

        a.transport.goOnline();

        for (let i = 0; i < 8; i++) {
          await a.engine.whenIdle();
          await b.engine.whenIdle();
        }
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 200);
        for (let i = 0; i < 4; i++) {
          await a.engine.whenIdle();
          await b.engine.whenIdle();
        }

        // NO conflict artifact anywhere: the loser carried the winner's exact content.
        expect([...conflictPaths(a.engine), ...conflictPaths(b.engine)]).toEqual([]);

        // And the content survived on both sides (the guard skips a COPY, it never drops bytes).
        expect(decode((await a.vault.read(DAILY)) ?? new Uint8Array())).toBe(A_BODY);
        expect(decode((await b.vault.read(DAILY)) ?? new Uint8Array())).toBe(A_BODY);

        await a.engine.stop();
        await b.engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
