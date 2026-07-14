/**
 * F2 — bounded, single-flight, progress-gated background self-heal (self-heal-pending.test.ts)
 *
 * ROOT CAUSE: `pendingDocs()` marks a live doc pending when `entry.stamp != getSyncedStamp(docId)`.
 * After the synced-stamp store is lost (relay reset / server migration) every un-acked doc's synced
 * stamp is gone → pending is non-empty — but NOTHING re-triggers convergence: the reconcile loop is
 * purely change-driven and `waitConverged` is TEST-ONLY. So pending never drains on its own.
 *
 * FIX: `requestSelfHeal()` arms a bounded, single-flight, progress-gated background driver that
 * re-runs `runFullConvergencePass` (spaced by backoff) until pending drains — reusing the SAME
 * idempotent chain `waitConverged` loops, with NO new write/stamp path (stamps still require the
 * real relay ACK), so it can never false-heal or lose data.
 *
 * Tests:
 *   1) drains-after-stamp-loss: converge → clear the synced-stamp map (simulate loss) → pending
 *      non-empty → drive the self-heal via fake timers → pending returns to EMPTY with NO external
 *      change. This is exactly what `waitConverged` does — the test proves the LIVE path now does it.
 *   2) bounded-no-spin: a doc that can NEVER clear (setSyncedStamp is a no-op, so its stamp mismatch
 *      persists) → the self-heal STOPS after SELFHEAL_MAX_NO_PROGRESS passes (bounded), leaving that
 *      doc pending — it does NOT loop forever.
 *   3) yields-to-live-work: a fresh change during the self-heal backoff is processed (not starved).
 *
 * Uses vi.useFakeTimers() + vi.advanceTimersByTimeAsync() (flushes microtasks between ticks) so the
 * backoff timer + audit iteration run deterministically without wall-clock waits — the SAME harness
 * style as audit-s6c.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SyncEngine,
  type EnginePorts,
  type EngineConfig,
  SELFHEAL_BACKOFF_MS,
  SELFHEAL_MAX_NO_PROGRESS,
} from "@zync/core";
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

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

interface Rig {
  engine: SyncEngine;
  vault: FakeVault;
  state: MemEngineState;
  docStore: FakeDocStore;
  transport: InProcessTransport;
}

/**
 * DURABLE storage that survives a "restart" (a fresh engine over the SAME stores). Reused across
 * two engine lifecycles to model the user's restart case: the vault (disk + base records), the
 * docStore (CRDT snapshots), and the engine-state (synced stamps) persist; only the in-memory
 * engine + transport are recreated.
 */
interface Durable {
  vault: FakeVault;
  docStore: FakeDocStore;
  state: MemEngineState;
}

function makeEngine(
  bus: InProcessBus,
  deviceId: string,
  stateOverride?: MemEngineState,
  durable?: Durable,
): Rig {
  const vault = durable?.vault ?? new FakeVault();
  const state = durable?.state ?? stateOverride ?? new MemEngineState();
  const docStore = durable?.docStore ?? new FakeDocStore();
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore,
    clock: new FakeClock(),
    identity: identity(deviceId),
    engineState: state,
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0, // immediate bumps so index.observe fires synchronously
  };
  return { engine: new SyncEngine(ports, config), vault, state, docStore, transport };
}

/**
 * Advance fake time far enough to fire the FULL self-heal backoff schedule several times over,
 * flushing microtasks between ticks so each armed backoff timer → audit iteration → next backoff
 * runs. Sum of the schedule × a generous multiple, well past what any drain needs.
 */
async function driveSelfHeal(engine: SyncEngine, rounds = 12): Promise<void> {
  const maxStep = Math.max(...SELFHEAL_BACKOFF_MS);
  for (let i = 0; i < rounds; i++) {
    // Advance past the LARGEST single backoff step so any armed backoff timer fires this round,
    // then fully drain the resulting async convergence pass (whenIdle) BEFORE the next advance —
    // otherwise a slow pass could still be in flight when we advance again and the newly-armed
    // next backoff timer would be measured from a stale point (the source of prior flakiness).
    await vi.advanceTimersByTimeAsync(maxStep + 100);
    await engine.whenIdle();
  }
}

// ══════════════════════════════════════════════════════════════════════════

describe("F2 self-heal — drains pending after synced-stamp loss", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Test 1: drains-after-stamp-loss ───────────────────────────────────────

  it(
    "1) drains-after-stamp-loss: pending returns to EMPTY with no external change",
    { timeout: 20_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const rig = makeEngine(bus, "dev-a");
        const { engine, vault, state } = rig;

        await engine.start();

        // Create a few notes and converge to a fixed point (pending empty).
        await vault.writeAtomic(path("heal/a.md"), utf8("alpha"));
        await vault.writeAtomic(path("heal/b.md"), utf8("bravo"));
        await vault.writeAtomic(path("heal/c.md"), utf8("charlie"));
        await engine.waitConverged();
        expect((await engine.pendingDocs()).length).toBe(0);

        // SIMULATE SYNCED-STAMP STORE LOSS: drop every persisted synced stamp. Now every live
        // doc's entry.stamp != getSyncedStamp → pendingDocs() is non-empty, with NO content change.
        state.clearAllSyncedStamps();
        const pendingAfterLoss = await engine.pendingDocs();
        expect(pendingAfterLoss.length).toBeGreaterThan(0);

        // Arm the self-heal (the seam a real reconnect-after-reset would hit) and let the bounded,
        // backoff-spaced driver run via fake timers. NO external change is made.
        engine.requestSelfHeal();
        await engine.whenIdle();
        await driveSelfHeal(engine);
        await engine.whenIdle();

        // The LIVE self-heal path drained pending to empty on its own — exactly what waitConverged
        // does, now proven for the background path.
        expect(await engine.pendingDocs()).toEqual([]);

        await engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 2: bounded-no-spin ───────────────────────────────────────────────

  it(
    "2) bounded-no-spin: a never-clearing doc STOPS the self-heal after the bound (stays pending)",
    { timeout: 20_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();

        // A state whose setSyncedStamp is a NO-OP: the synced stamp is never persisted, so
        // entry.stamp != getSyncedStamp holds FOREVER for every live doc — a doc that can never
        // clear (models a genuinely stuck relay / unresolvable conflict). The self-heal must be
        // BOUNDED: stop after SELFHEAL_MAX_NO_PROGRESS no-progress passes, not loop forever.
        const stuckState = new MemEngineState();
        let sawSet = false;
        stuckState.setSyncedStamp = (): Promise<void> => {
          sawSet = true;
          return Promise.resolve(); // swallow — never actually persist
        };

        const rig = makeEngine(bus, "dev-a", stuckState);
        const { engine, vault } = rig;

        // Watch the STOP diagnostic. The bounded self-heal logs EXACTLY ONE "self-heal STOPPED"
        // per arming (after SELFHEAL_MAX_NO_PROGRESS no-progress passes). A doc that never clears
        // must produce a FINITE number of stops (the driver terminates), never an unbounded stream.
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const stopCount = (): number =>
          warnSpy.mock.calls.filter(
            (c) => typeof c[0] === "string" && c[0].includes("self-heal STOPPED"),
          ).length;

        await engine.start();
        await vault.writeAtomic(path("stuck/x.md"), utf8("cannot-clear"));
        await engine.whenIdle();

        expect(sawSet).toBe(true); // catch-up DID try to advance the stamp (it just never sticks)
        expect((await engine.pendingDocs()).length).toBeGreaterThan(0); // doc (correctly) still pending
        // OPT-IN: the self-heal is NOT auto-armed by ordinary audits — no stop has fired yet even
        // though the doc is durably pending. (Established audit-once semantics stay intact.)
        await driveSelfHeal(engine);
        await engine.whenIdle();
        expect(stopCount()).toBe(0);

        // TERMINATION PROOF: arm the self-heal explicitly. On a doc that can NEVER clear it must
        // drive to its no-progress bound and STOP exactly ONCE — never loop. Then burn a LARGE
        // amount of additional fake time and assert NO further stop fires (genuinely halted, not
        // merely slow): the count stays at 1 no matter how much more time passes.
        engine.requestSelfHeal();
        await engine.whenIdle();
        await driveSelfHeal(engine, SELFHEAL_MAX_NO_PROGRESS + 2);
        await engine.whenIdle();
        expect(stopCount()).toBe(1); // the arm drove to the bound and stopped exactly once

        await driveSelfHeal(engine, 30); // way more time than any bounded run needs
        await engine.whenIdle();
        expect(stopCount()).toBe(1); // STILL 1 — the self-heal did NOT re-arm itself / loop forever

        // The doc is STILL pending (visibly, never silently "healed").
        expect((await engine.pendingDocs()).length).toBeGreaterThan(0);

        warnSpy.mockRestore();
        await engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 3: yields-to-live-work ───────────────────────────────────────────

  it(
    "3) yields-to-live-work: a fresh change during the self-heal backoff is processed",
    { timeout: 20_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const rig = makeEngine(bus, "dev-a");
        const { engine, vault, state } = rig;

        await engine.start();
        await vault.writeAtomic(path("live/seed.md"), utf8("seed"));
        await engine.waitConverged();
        expect((await engine.pendingDocs()).length).toBe(0);

        // Lose the synced stamps and arm the self-heal.
        state.clearAllSyncedStamps();
        engine.requestSelfHeal();
        await engine.whenIdle();

        // While the self-heal is spaced by backoff, a FRESH user change lands. It must be processed
        // (not starved) — a fresh change always takes priority over the background self-heal.
        await vault.writeAtomic(path("live/fresh.md"), utf8("fresh user edit"));
        await engine.whenIdle();

        // The fresh file is present + bound in the index (the change-driven loop processed it,
        // independent of the self-heal backoff — no starvation).
        const freshEntry = engine.index.get(path("live/fresh.md"));
        expect(freshEntry).toBeDefined();
        expect(freshEntry?.deleted).not.toBe(true);

        // And the self-heal still drives everything (seed + fresh) to a converged fixed point.
        await driveSelfHeal(engine);
        await engine.whenIdle();
        expect(await engine.pendingDocs()).toEqual([]);

        await engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 4: STARTUP auto-arm WIRE fires requestSelfHeal when the initial pass leaves pending ──
  //
  // Isolates the STARTUP auto-trigger WIRE added to start(): after the initial convergence pass, if
  // durable pending is non-empty, start() arms the self-heal ITSELF (no manual call). In-process a
  // healthy startup pass drains everything, so to exercise the wire deterministically we make the
  // startup pass a NO-OP once and force the post-pass durablePendingDocs check to report non-empty
  // ONCE (simulating "the startup pass did not fully drain"). We then assert start() called its OWN
  // requestSelfHeal. This proves the exact conditional the user's restart-recovery relies on.

  it(
    "4) startup-auto-arm: start() fires its OWN requestSelfHeal when the initial pass leaves pending",
    { timeout: 20_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        const rig = makeEngine(bus, "dev-a");
        const { engine } = rig;

        // Neutralize the ONE startup full pass so it cannot drain, and make the post-pass durable
        // pending check report non-empty exactly ONCE (the startup .then()'s check) — modelling a
        // startup pass that left pending. Later real checks return empty.
        vi.spyOn(engine, "runFullConvergencePass").mockResolvedValueOnce(undefined);
        const dummyPending = ["stuck-doc" as unknown as never];
        vi.spyOn(
          engine as unknown as { durablePendingDocs: () => Promise<never[]> },
          "durablePendingDocs",
        ).mockResolvedValueOnce(dummyPending);
        const selfHealSpy = vi.spyOn(engine, "requestSelfHeal");

        await engine.start();
        await engine.whenIdle(); // start()'s tracked (no-op) pass + its auto-arm .then() run

        // WIRE PROVEN: start() observed pending non-empty after its initial pass → armed the
        // self-heal ITSELF. The test never called requestSelfHeal.
        expect(selfHealSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

        selfHealSpy.mockRestore();
        await engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ── Test 5: AUTO-trigger on RESTART end-to-end (no manual requestSelfHeal) ──
  //
  // Models the user's literal "restart → pending drains on its own" case: a device converges, its
  // synced-stamp store is lost, and a FRESH engine boots over the SAME durable stores. The device
  // recovers to pending-empty with NO manual requestSelfHeal() — the startup convergence + the
  // startup auto-trigger (which arms the self-heal iff one pass leaves pending) handle it together.

  it(
    "5) auto-recovery-on-restart: a restarted engine drains pending after stamp loss (no manual call)",
    { timeout: 20_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const bus = new InProcessBus();
        // DURABLE stores shared across the two engine lifecycles (models a real restart).
        const durable: Durable = {
          vault: new FakeVault(),
          docStore: new FakeDocStore(),
          state: new MemEngineState(),
        };

        // ── Lifecycle 1: converge a few notes, then LOSE the synced stamps, then stop. ──
        const rig1 = makeEngine(bus, "dev-a", undefined, durable);
        await rig1.engine.start();
        await rig1.vault.writeAtomic(path("boot/a.md"), utf8("alpha"));
        await rig1.vault.writeAtomic(path("boot/b.md"), utf8("bravo"));
        await rig1.engine.waitConverged();
        expect((await rig1.engine.pendingDocs()).length).toBe(0);
        // SIMULATE SYNCED-STAMP STORE LOSS on the DURABLE state (survives the restart as lost).
        durable.state.clearAllSyncedStamps();
        await rig1.engine.stop();

        // ── Lifecycle 2: RESTART a FRESH engine over the SAME durable stores. No manual call. ──
        const rig2 = makeEngine(bus, "dev-a", undefined, durable);
        await rig2.engine.start();
        await rig2.engine.whenIdle(); // start()'s tracked pass + its auto-arm .then() run
        // Drive fake timers in case the startup pass left pending and armed the self-heal.
        await driveSelfHeal(rig2.engine);
        await rig2.engine.whenIdle();

        // AUTO-RECOVERED: pending is empty after restart with NO manual requestSelfHeal() call.
        expect(await rig2.engine.pendingDocs()).toEqual([]);

        await rig2.engine.stop();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
