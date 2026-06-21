/**
 * S6c — hybrid low-frequency full convergence audit (audit-s6c.test.ts)
 *
 * Deterministic, fake-timer-based tests for the trigger logic added in S6c:
 *
 *   1. quiescence-audit-fires: after reconcile activity, advancing fake time past
 *      AUDIT_QUIESCENCE_MS triggers exactly ONE runFullConvergencePass audit iteration
 *      that whenIdle() awaits.
 *
 *   2. watchdog-one-shot-under-sustained-load (O(n^2) guard): continuous reconcile
 *      activity (loop never idles) past AUDIT_MAX_STALENESS_MS triggers AT MOST ONE
 *      watchdog audit, NOT one-per-interval. This test is LOAD-BEARING for the
 *      O(n^2)-avoidance guarantee — verified by removing the latch to confirm failure.
 *
 *   3. audit-cleared-on-stop: after arming both timers, stop() clears them; advancing
 *      fake time after stop fires NO audit.
 *
 *   4. audit-serialized: the full-pass audit does not overlap a scoped pass — the same
 *      single-threaded loop runs them sequentially.
 *
 * Uses vi.useFakeTimers() + vi.advanceTimersByTimeAsync() (which flushes microtasks
 * between each tick step). Real reconcile work is kept minimal (no two-device relay)
 * so the loop drains quickly and we can observe timer behavior cleanly.
 *
 * Spying uses vi.spyOn on the PUBLIC methods runFullConvergencePass and
 * runObserveScopedReconcile — no private access needed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SyncEngine,
  type EnginePorts,
  type EngineConfig,
  AUDIT_QUIESCENCE_MS,
  AUDIT_MAX_STALENESS_MS,
} from "@zync/core";
import type { DeviceId, IdentityPort, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

// ── helpers ────────────────────────────────────────────────────────────────

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

function makeEngine(bus: InProcessBus, deviceId: string): { engine: SyncEngine; vault: FakeVault } {
  const vault = new FakeVault();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
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
    stampDebounceMs: 0, // immediate bumps so index.observe fires synchronously
  };
  return { engine: new SyncEngine(ports, config), vault };
}

// ══════════════════════════════════════════════════════════════════════════
// S6c audit trigger tests
// ══════════════════════════════════════════════════════════════════════════

describe("S6c audit triggers", () => {
  // Restore real timers after each test in case a test fails mid-run.
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Test 1: quiescence-audit-fires ────────────────────────────────────────

  it(
    "1) quiescence-audit-fires: exactly ONE full audit fires after loop goes idle",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const { engine, vault } = makeEngine(bus, "dev-a");

        // Spy on the public runFullConvergencePass method to count invocations.
        // vi.spyOn wraps the method and calls through to the original.
        const fullSpy = vi.spyOn(engine, "runFullConvergencePass");

        await engine.start();
        // start() calls runFullConvergencePass once in step 9 — let it settle.
        await engine.whenIdle();
        const startupCount = fullSpy.mock.calls.length;

        // Trigger reconcile activity: write a file so the engine observes a change.
        await vault.writeAtomic(path("test/note.md"), utf8("hello"));
        // Let the observe-driven scoped pass run to completion.
        await engine.whenIdle();

        // Now the loop is idle. Advance fake time past AUDIT_QUIESCENCE_MS.
        // vi.advanceTimersByTimeAsync flushes microtasks between ticks, so the
        // quiescence timer callback runs + scheduleReconcile fires + the audit
        // loop iteration completes.
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 100);

        // Await the audit iteration (tracked in the loop promise, inside inflight).
        await engine.whenIdle();

        // Exactly ONE audit should have fired since startup.
        expect(fullSpy.mock.calls.length - startupCount).toBe(1);

        await engine.stop();
        fullSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 2: at-most-one audit per epoch (quiescence + watchdog combined) ──────
  //
  // F2 contract: during an IDLE period after work completes (all backstop sets empty),
  // exactly ONE full audit fires — from the quiescence path. The watchdog does NOT fire
  // a second audit because the quiescence audit ends the busy epoch (clears the watchdog
  // timer and resets `auditedThisBusyEpoch`).
  //
  // This test verifies that advancing past BOTH AUDIT_QUIESCENCE_MS and
  // AUDIT_MAX_STALENESS_MS from a single epoch produces EXACTLY ONE full audit,
  // not two (one from quiescence + one from watchdog). The epoch ends when quiescence
  // fires, so the watchdog's timer is cleared and cannot fire afterward.
  //
  // Load-bearing: removing the watchdog-timer-clear in the quiescence callback would
  // allow the watchdog to fire AFTER the quiescence, producing 2 total audits.

  it(
    "2) at-most-one-audit-per-epoch: quiescence audit fires once; watchdog cannot fire after epoch ends",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const { engine, vault } = makeEngine(bus, "dev-a");

        const fullSpy = vi.spyOn(engine, "runFullConvergencePass");

        await engine.start();
        await engine.whenIdle();
        const startupCount = fullSpy.mock.calls.length;

        // Write one file to start a busy epoch (arms both the quiescence timer and
        // the watchdog stale timer). Wait for the scoped pass to complete.
        await vault.writeAtomic(path("epoch/note.md"), utf8("content"));
        await engine.whenIdle();

        // Advance past BOTH windows in one step. The quiescence timer fires FIRST
        // (AUDIT_QUIESCENCE_MS = 15000 < AUDIT_MAX_STALENESS_MS = 30000):
        //   1. Quiescence fires → outstanding work empty → audit requested (audit #1)
        //      → epoch ends (clears auditStaleTimer, resets auditedThisBusyEpoch)
        //   2. The quiescence has cleared the stale timer → watchdog CANNOT fire
        //   3. No second audit from the watchdog.
        await vi.advanceTimersByTimeAsync(AUDIT_MAX_STALENESS_MS + AUDIT_QUIESCENCE_MS + 500);
        await engine.whenIdle();

        const totalAudits = fullSpy.mock.calls.length - startupCount;
        // EXACTLY 1: the quiescence fired once; the watchdog timer was cleared by the
        // epoch-end logic in the quiescence callback, so it cannot produce a second audit.
        expect(totalAudits).toBe(1);

        // LOAD-BEARING: if the quiescence callback did NOT clear the auditStaleTimer,
        // the watchdog would fire after AUDIT_MAX_STALENESS_MS, producing 2 total audits.
        // The assertion `=== 1` would fail, confirming the timer-clear is load-bearing.

        await engine.stop();
        fullSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 6: watchdog SUPPRESSED while progressing (F2 contract) ───────────
  //
  // F2 new contract: the watchdog does NOT fire during a progressing seed.
  // When reconcileProgressTick advances between arm and fire, the watchdog
  // re-arms for another window without firing an audit.
  //
  // This test verifies the suppression path: continuous write activity keeps
  // the tick advancing, so the watchdog keeps re-arming without ever firing.
  // The system is NOT stalled — it is actively processing work.
  //
  // LOAD-BEARING: this test documents the O(n^2) fix. Without the progress
  // gate, the watchdog would fire ~(storm_duration/AUDIT_MAX_STALENESS_MS)
  // times during a seed, giving O(n^2) total cost. With the gate, it fires 0
  // times during a healthy seed.

  it(
    "6) watchdog-suppressed-while-progressing: no watchdog audit fires during active seed (F2)",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const { engine, vault } = makeEngine(bus, "dev-a");

        const fullSpy = vi.spyOn(engine, "runFullConvergencePass");

        await engine.start();
        await engine.whenIdle();
        const startupCount = fullSpy.mock.calls.length;

        // Write initial note to start a busy epoch (arms the watchdog stale timer).
        await vault.writeAtomic(path("busy/note0.md"), utf8("content 0"));
        await engine.whenIdle();

        // Simulate sustained load: advance time in small steps, adding new reconcile
        // work each step to keep the tick advancing (active seed simulation).
        //
        // stepMs must be < AUDIT_QUIESCENCE_MS to prevent the quiescence timer from
        // firing (which would fire an audit via the settled-work path).
        // Each step writes a file → index.observe fires → reconcileProgressTick++.
        //
        // totalMs spans multiple AUDIT_MAX_STALENESS_MS windows so we can verify the
        // watchdog keeps re-arming without firing over all of them.
        const stepMs = Math.floor(AUDIT_QUIESCENCE_MS / 2);
        const totalMs = AUDIT_MAX_STALENESS_MS * 3;
        const steps = Math.ceil(totalMs / stepMs);

        for (let i = 0; i < steps; i++) {
          // Keep the tick advancing with new work before each time advance.
          await vault.writeAtomic(
            path(`busy/note${String(i + 1)}.md`),
            utf8(`content ${String(i + 1)}`),
          );
          // Advance time — short step so quiescence timer never fires.
          await vi.advanceTimersByTimeAsync(stepMs);
          // Flush microtasks so queued reconcile work drains.
          await engine.whenIdle();
        }

        // After sustained progressing load well past AUDIT_MAX_STALENESS_MS * 3, the
        // watchdog should NOT have fired (it kept re-arming on each progress window).
        const auditsDuringBusy = fullSpy.mock.calls.length - startupCount;
        // F2 contract: ZERO watchdog audits during a progressing seed.
        expect(auditsDuringBusy).toBe(0);

        // LOAD-BEARING VERIFICATION (F2 O(n^2) fix):
        // Without the progress-aware gate in armWatchdogTimer, the watchdog would fire
        // once per AUDIT_MAX_STALENESS_MS window regardless of progress. Over 3 windows,
        // auditsDuringBusy would be ~3 (or at least 1), not 0. This assertion documents
        // that the gate is the load-bearing mechanism: removing the progress check in
        // armWatchdogTimer causes this test to FAIL.

        await engine.stop();
        fullSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 3: audit-cleared-on-stop ─────────────────────────────────────────

  it(
    "3) audit-cleared-on-stop: stop() clears both timers; no audit fires after stop",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const { engine, vault } = makeEngine(bus, "dev-a");

        const fullSpy = vi.spyOn(engine, "runFullConvergencePass");

        await engine.start();
        await engine.whenIdle();

        // Trigger some activity to arm the quiescence timer and start a busy epoch.
        await vault.writeAtomic(path("stop/note.md"), utf8("stop test"));
        await engine.whenIdle();

        // The quiescence timer is now armed (and potentially the stale timer too).
        // stop() must clear both timers so no audit fires after shutdown.
        await engine.stop();
        const passCountAtStop = fullSpy.mock.calls.length;

        // Advance well past both timer thresholds.
        await vi.advanceTimersByTimeAsync(AUDIT_MAX_STALENESS_MS * 2 + AUDIT_QUIESCENCE_MS * 2);

        // No new full-pass invocations should have fired after stop().
        expect(fullSpy.mock.calls.length).toBe(passCountAtStop);

        fullSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 5: no-repeated-idle-audit (regression for S6c re-arm bug) ──────────
  //
  // BUG: before the fix, the quiescence timer was re-armed at the TOP of EVERY
  // runReconcileLoop iteration, INCLUDING the audit iteration. Sequence:
  //   1. Quiescence fires → auditRequested=true, scheduleReconcile().
  //   2. Loop wakes, enters while, re-arms timer at TOP (BUG), runs audit, continue.
  //   3. while-condition false → loop exits. But the fresh timer from step 2 is still
  //      pending → fires AUDIT_QUIESCENCE_MS later → step 1 again → infinite cycle.
  //
  // EXPECTED (post-fix): after one initial quiescence audit the system is truly idle;
  // advancing fake time by 3 × AUDIT_QUIESCENCE_MS fires AT MOST 1 additional audit
  // (the loop exits without re-arming after the audit iteration).
  //
  // PRE-FIX COUNT (empirical): advancing 3 × AUDIT_QUIESCENCE_MS would observe ~4
  // total audits (startup + 3 idle-repeat audits), NOT 1.

  it(
    "5) no-repeated-idle-audit: after one quiescence audit, idle time does NOT trigger more audits",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const { engine, vault } = makeEngine(bus, "dev-a");

        const fullSpy = vi.spyOn(engine, "runFullConvergencePass");

        await engine.start();
        // Let startup's runFullConvergencePass settle.
        await engine.whenIdle();
        const startupCount = fullSpy.mock.calls.length;

        // Trigger one scoped-pass to arm the quiescence timer.
        await vault.writeAtomic(path("idle/note.md"), new TextEncoder().encode("content"));
        await engine.whenIdle();

        // Advance past quiescence: the first audit fires here.
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 100);
        await engine.whenIdle();

        // Exactly 1 audit should have fired since startup.
        const afterFirstAudit = fullSpy.mock.calls.length - startupCount;
        expect(afterFirstAudit).toBe(1);

        // Now the system is idle. Keep advancing for 3 × AUDIT_QUIESCENCE_MS with NO
        // new reconcile work. Post-fix: no quiescence timer is pending after the audit
        // iteration (the loop exited without re-arming), so NO additional audit fires.
        // Pre-fix: the timer would be re-armed on every audit iteration → ~3 more audits.
        await vi.advanceTimersByTimeAsync(3 * AUDIT_QUIESCENCE_MS);
        await engine.whenIdle();

        const totalAfterIdle = fullSpy.mock.calls.length - startupCount;
        // Post-fix: still exactly 1 (the initial quiescence audit; no repeats while idle).
        // Pre-fix: would be ~4 (1 initial + ~3 repeated idle audits).
        expect(totalAfterIdle).toBe(1);

        await engine.stop();
        fullSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 4: audit-serialized ───────────────────────────────────────────────

  it(
    "4) audit-serialized: full audit never runs concurrently with a scoped pass",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const { engine, vault } = makeEngine(bus, "dev-a");

        // Track concurrent execution via counting active invocations.
        let activeCount = 0;
        let maxConcurrent = 0;

        // Capture the originals before spying.
        const origScoped = engine.runObserveScopedReconcile.bind(engine);
        const origFull = engine.runFullConvergencePass.bind(engine);

        // Spy on scoped reconcile — calls through to original.
        vi.spyOn(engine, "runObserveScopedReconcile").mockImplementation(async (bundle) => {
          activeCount++;
          if (activeCount > maxConcurrent) maxConcurrent = activeCount;
          try {
            await origScoped(bundle);
          } finally {
            activeCount--;
          }
        });

        // Spy on full convergence pass — calls through to original.
        vi.spyOn(engine, "runFullConvergencePass").mockImplementation(async () => {
          activeCount++;
          if (activeCount > maxConcurrent) maxConcurrent = activeCount;
          try {
            await origFull();
          } finally {
            activeCount--;
          }
        });

        await engine.start();
        await engine.whenIdle();

        // Trigger activity to arm quiescence timer.
        await vault.writeAtomic(path("serial/note.md"), utf8("serialization test"));
        await engine.whenIdle();

        // Advance past quiescence to trigger the audit.
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 100);
        await engine.whenIdle();

        // maxConcurrent must be <= 1: the loop serializes audit and scoped-pass
        // iterations — each runs to completion before the next starts.
        expect(maxConcurrent).toBeLessThanOrEqual(1);

        await engine.stop();
        vi.restoreAllMocks();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 7: quiescence audit SUPPRESSED when outstanding scoped-path work exists ─
  //
  // F2's quiescence gate: the audit does NOT fire if `hasOutstandingWork()` is true (any
  // scoped-path backstop set — needsCatchUp / remoteUpdatedSinceSettle / pendingDivergence —
  // is non-empty). This is the mechanism that suppresses the ~70 mid-seed audits the on-device
  // profile found: between relay round-trips the system still has in-progress convergence work.
  //
  // We exercise the gate branch DIRECTLY by forcing `hasOutstandingWork()` true (a single-device
  // InProcessBus drains its backstop sets synchronously, so it cannot naturally hold a set
  // non-empty across a quiescence window — stubbing the predicate is the deterministic way to
  // drive the suppression branch). With it true at quiescence: NO audit. With it false: the audit
  // fires. LOAD-BEARING: if the `!this.hasOutstandingWork()` gate is removed, step (b) fires the
  // audit despite the stub → the `toBe(0)` assertion fails.

  it(
    "7) quiescence-suppression-gate: outstanding work suppresses the quiescence audit",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const { engine, vault } = makeEngine(bus, "dev-a");
        // Control hasOutstandingWork() directly (private — shadow the prototype method).
        const gated = engine as unknown as { hasOutstandingWork: () => boolean };
        const realHasOutstandingWork = gated.hasOutstandingWork.bind(engine);

        const fullSpy = vi.spyOn(engine, "runFullConvergencePass");

        await engine.start();
        await engine.whenIdle();
        const startupCount = fullSpy.mock.calls.length;

        // (a) SUPPRESSED: write a note (arms the quiescence timer), force outstanding work
        // true, then advance past the window. The quiescence callback must SKIP the audit.
        await vault.writeAtomic(path("gate/note1.md"), utf8("content 1"));
        await engine.whenIdle();
        gated.hasOutstandingWork = (): boolean => true;
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 100);
        await engine.whenIdle();
        expect(fullSpy.mock.calls.length - startupCount).toBe(0); // audit suppressed

        // (b) ALLOWED: restore the real predicate (system is settled → false), arm the timer
        // again with fresh activity, advance — now the audit MUST fire.
        gated.hasOutstandingWork = realHasOutstandingWork;
        await vault.writeAtomic(path("gate/note2.md"), utf8("content 2"));
        await engine.whenIdle();
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 100);
        await engine.whenIdle();
        expect(fullSpy.mock.calls.length - startupCount).toBe(1); // audit fired once

        await engine.stop();
        fullSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 8: watchdog SUPPRESSED during ack-tail via advanceAckedBase (F4) ─────
  //
  // F4 contract: each call to advanceAckedBase (the onPushAcked seam wired at engine.ts:513)
  // increments reconcileProgressTick synchronously (before its awaits). During the relay
  // ack-tail — pushes are done, the relay acks one-by-one — there are NO index.observe bumps
  // and NO remote-doc updates, so without F4 the tick STALLS and the watchdog mis-fires ~once
  // per AUDIT_MAX_STALENESS_MS.
  //
  // Strategy: arm the watchdog by writing a file, then call advanceAckedBase (via private cast)
  // BEFORE advancing time past AUDIT_MAX_STALENESS_MS. With F4 the tick advances → watchdog
  // re-arms without firing → ZERO audits. Without F4 the tick stays frozen → watchdog fires.
  //
  // LOAD-BEARING: removing `reconcileProgressTick++` from advanceAckedBase leaves the tick
  // unchanged → the watchdog fires when the window expires → auditsDuringTail >= 1 → the
  // `toBe(0)` assertion FAILS. This experiment is described in the body comment below.

  it(
    "8) watchdog-suppressed-during-ack-tail: advanceAckedBase progress prevents mis-fire (F4)",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const { engine, vault } = makeEngine(bus, "dev-a");

        const fullSpy = vi.spyOn(engine, "runFullConvergencePass");

        // Access private fields/methods via cast.
        const privateEngine = engine as unknown as {
          advanceAckedBase: (doc: {
            id: string;
            getText: () => string;
            encodeStateVector: () => Uint8Array;
            encodeSnapshot: () => Uint8Array;
          }) => Promise<void>;
          reconcileProgressTick: number;
          hasOutstandingWork: () => boolean;
        };

        await engine.start();
        await engine.whenIdle();
        const startupCount = fullSpy.mock.calls.length;

        // Write a note to arm a busy epoch. This arms both:
        //   - the quiescence timer (fires at AUDIT_QUIESCENCE_MS = 15s)
        //   - the watchdog stale timer (fires at AUDIT_MAX_STALENESS_MS = 30s)
        await vault.writeAtomic(path("ack-tail/seed.md"), utf8("seed"));
        await engine.whenIdle();

        // Stub hasOutstandingWork() → true so the quiescence timer fires but is SUPPRESSED
        // (the quiescence callback skips the audit when hasOutstandingWork() is true).
        // This mirrors the ack-tail scenario: the relay is still acking docs, so there IS
        // outstanding convergence work — the quiescence gate would suppress the audit.
        // Without this stub the quiescence timer fires at 15s and emits an audit, muddying
        // the watchdog-only assertion we need for Test 8.
        const realHasOutstandingWork = privateEngine.hasOutstandingWork.bind(engine);
        privateEngine.hasOutstandingWork = (): boolean => true;

        const stubDoc = {
          id: "stub-ack-doc-f4",
          getText: (): string => "acked content",
          encodeStateVector: (): Uint8Array => new Uint8Array(0),
          encodeSnapshot: (): Uint8Array => new Uint8Array(0),
        };

        // ── (a) TICK BUMP ASSERTION ──────────────────────────────────────────
        // Capture the tick before calling advanceAckedBase. The F4 increment fires
        // synchronously at the very start of advanceAckedBase (before any awaits).
        // LOAD-BEARING: removing `this.reconcileProgressTick++` from advanceAckedBase
        // leaves the tick unchanged → this assertion fails immediately.
        const tickBefore = privateEngine.reconcileProgressTick;
        await privateEngine.advanceAckedBase(stubDoc);
        expect(privateEngine.reconcileProgressTick).toBe(tickBefore + 1);

        // ── (b) WATCHDOG SUPPRESSION ─────────────────────────────────────────
        // Advance past AUDIT_QUIESCENCE_MS first — quiescence fires but is suppressed
        // (hasOutstandingWork() returns true). Zero audits so far.
        await vi.advanceTimersByTimeAsync(AUDIT_QUIESCENCE_MS + 100);
        await engine.whenIdle();
        expect(fullSpy.mock.calls.length - startupCount).toBe(0); // quiescence suppressed

        // Simulate another ack arriving (bumps the tick again for the watchdog window).
        await privateEngine.advanceAckedBase(stubDoc);

        // Advance past the watchdog deadline (AUDIT_MAX_STALENESS_MS from when epoch started).
        // The watchdog fires and reads reconcileProgressTick vs the tick-at-arm:
        //   WITH F4: tick advanced (ack bumps) → watchdog re-arms without auditing → 0 audits.
        //   WITHOUT F4: tick frozen → watchdog fires a full audit → auditsDuringTail >= 1.
        const remainingMs = AUDIT_MAX_STALENESS_MS - AUDIT_QUIESCENCE_MS + 100;
        await vi.advanceTimersByTimeAsync(remainingMs);
        await engine.whenIdle();

        const auditsDuringTail = fullSpy.mock.calls.length - startupCount;
        // F4 contract: ZERO watchdog audits when ack-tail progress kept the tick moving.
        // LOAD-BEARING: without `reconcileProgressTick++` in advanceAckedBase the watchdog
        // fires here (auditsDuringTail >= 1), failing this assertion. Restoring the bump
        // makes the test GREEN — proving the F4 increment is the sole suppression mechanism.
        expect(auditsDuringTail).toBe(0);

        // Restore real hasOutstandingWork before teardown.
        privateEngine.hasOutstandingWork = realHasOutstandingWork;

        await engine.stop();
        fullSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
