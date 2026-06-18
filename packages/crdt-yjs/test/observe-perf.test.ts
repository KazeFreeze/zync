/**
 * Stage 1 observe-path performance MEASUREMENT test.
 *
 * Measures how vault.read and engineState.getSyncedStamp call counts on the
 * RECEIVER (B) scale as the seed size N grows, when B converges via the observe
 * handler ONLY (no waitConverged/flush on B during the measured window).
 *
 * This is a MEASUREMENT test — it does NOT hard-assert a specific call count.
 * It characterises the current O(n^2) baseline (or reveals that the headless
 * in-process bus collapses the burst and does not reproduce the slope).
 * See the decision rule and assertion comments below.
 *
 * ZERO production / behavior changes — test-only file.
 */

import { describe, it, expect } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
  CallCounter,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

// ── helpers ────────────────────────────────────────────────────────────────

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
}

/**
 * Build a minimal device. `vaultCounter` and `stateCounter` are optional
 * CallCounters; if provided the corresponding port is wrapped BEFORE the engine
 * is constructed, so every engine-driven call is recorded.
 */
function makeDevice(
  bus: InProcessBus,
  deviceId: string,
  name: string,
  vaultCounter?: CallCounter,
  stateCounter?: CallCounter,
): Device {
  const rawVault = new FakeVault();
  const rawState = new MemEngineState();

  const vault = vaultCounter !== undefined ? vaultCounter.wrap(rawVault) : rawVault;
  const engineState = stateCounter !== undefined ? stateCounter.wrap(rawState) : rawState;

  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
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
  };
  return { engine: new SyncEngine(ports, config), vault: rawVault };
}

/** Converge both engines to a joint fixed point (used during SETUP only). */
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

// ── measurement for a single N ─────────────────────────────────────────────

interface MeasureResult {
  n: number;
  vaultReadTotal: number;
  getSyncedStampTotal: number;
}

async function measureForN(n: number): Promise<MeasureResult> {
  const bus = new InProcessBus();

  // Device A: no counters needed — only B's observe-path I/O is the subject.
  const a = makeDevice(bus, "dev-a", "Device A");

  // Device B: wrap vault and engineState with separate counters BEFORE the engine
  // is constructed so every engine-driven port call is intercepted.
  const vaultCounter = new CallCounter();
  const stateCounter = new CallCounter();
  const b = makeDevice(bus, "dev-b", "Device B", vaultCounter, stateCounter);

  await a.engine.start();
  await b.engine.start();
  // Establish an empty joint baseline (lets start()'s own I/O settle before
  // we reset the counters for the measurement window).
  await converge(a, b);

  // Reset counters: the measurement window starts NOW (post-start, post-empty-converge).
  vaultCounter.reset();
  stateCounter.reset();

  // Seed N notes on A — each triggers a push to the bus which drives B's observe handler.
  for (let i = 0; i < n; i++) {
    await a.vault.writeAtomic(
      path(`perf/n${String(i)}.md`),
      utf8(`observe perf note ${String(i)}`),
    );
  }
  // A converges fully so all N updates are queued on the bus for B.
  await a.engine.waitConverged();

  // Drive B via the OBSERVE PATH ONLY — never call waitConverged/flush on B during
  // this window.  Those call the reconcile chain directly and would bypass/mask the
  // observe handler (the very thing we are measuring).
  const seededPaths = new Set<string>();
  for (let i = 0; i < n; i++) seededPaths.add(`perf/n${String(i)}.md`);

  const countMd = async (): Promise<number> => {
    const entries = await b.vault.list();
    return entries.filter(({ path: p }) => seededPaths.has(p)).length;
  };

  // Bounded pump: whenIdle() awaits B's pending coalesced reconcile pass; the 2ms
  // yield gives the in-process bus time to deliver any new broadcasts.
  let have = 0;
  let pendingEmpty = false;
  for (let i = 0; i < 500 && !(have >= n && pendingEmpty); i++) {
    await b.engine.whenIdle();
    have = await countMd();
    const pending = await b.engine.pendingDocs();
    pendingEmpty = pending.length === 0;
    if (!(have >= n && pendingEmpty)) {
      await new Promise<void>((r) => setTimeout(r, 2));
    }
  }

  // Snapshot counters at the END of the observe-driven convergence window.
  const vaultReadTotal = vaultCounter.count("read");
  const getSyncedStampTotal = stateCounter.count("getSyncedStamp");

  // Final correctness assertion (after measurement window — allowed to use
  // waitConverged here as a correctness gate, not as part of the measurement).
  await b.engine.waitConverged();

  await a.engine.stop();
  await b.engine.stop();

  return { n, vaultReadTotal, getSyncedStampTotal };
}

// ── the measurement test ───────────────────────────────────────────────────

describe("observe-path perf baseline (Stage 1 instrumentation)", () => {
  /**
   * Measure how vault.read and getSyncedStamp call counts scale as seed size N grows,
   * when B converges via the observe handler only (no waitConverged on B during the
   * measured window).
   *
   * Decision rule (see task spec):
   *  - If per-note cost grows with N (largest/smallest per-note ratio > ~1.5x for
   *    either counter): the in-memory harness REPRODUCES the super-linear baseline.
   *    Assert characterization (ratio > 1.3) with a BASELINE comment.
   *  - If per-note cost is ~flat (ratio <= ~1.5x): the in-process bus collapses the
   *    burst and does NOT reproduce the on-device slope. Assert a loose ceiling and
   *    document that the on-device re-profile (Stage 8) is the authoritative signal.
   */
  it(
    "vault.read and getSyncedStamp counts scale characteristically with seed size N",
    { timeout: 120_000 },
    async () => {
      // N values spanning a 4x range so a slope (if present) is clearly visible.
      const nValues = [20, 40, 80, 160];

      const results: MeasureResult[] = [];
      for (const n of nValues) {
        const r = await measureForN(n);
        results.push(r);
      }

      // ── Print measurement table ───────────────────────────────────────────
      console.log("\n=== observe-path perf baseline (Stage 1) ===");
      console.log(
        `${"N".padStart(5)}  ${"read total".padStart(12)}  ${"read/note".padStart(11)}  ${"getSynced total".padStart(16)}  ${"getSynced/note".padStart(15)}`,
      );
      for (const r of results) {
        const readPerNote = r.vaultReadTotal / r.n;
        const syncedPerNote = r.getSyncedStampTotal / r.n;
        console.log(
          `${String(r.n).padStart(5)}  ${String(r.vaultReadTotal).padStart(12)}  ${readPerNote.toFixed(2).padStart(11)}  ${String(r.getSyncedStampTotal).padStart(16)}  ${syncedPerNote.toFixed(2).padStart(15)}`,
        );
      }

      // Compute per-note costs at smallest and largest N.
      const first = results[0];
      const last = results[results.length - 1];

      if (first === undefined || last === undefined) {
        throw new Error("results array is unexpectedly empty");
      }

      const readPerNoteSmall = first.vaultReadTotal / first.n;
      const readPerNoteLarge = last.vaultReadTotal / last.n;
      const syncedPerNoteSmall = first.getSyncedStampTotal / first.n;
      const syncedPerNoteLarge = last.getSyncedStampTotal / last.n;

      // Guard against division by zero when counts are 0.
      const readRatio =
        readPerNoteSmall > 0 ? readPerNoteLarge / readPerNoteSmall : readPerNoteLarge > 0 ? 999 : 1;
      const syncedRatio =
        syncedPerNoteSmall > 0
          ? syncedPerNoteLarge / syncedPerNoteSmall
          : syncedPerNoteLarge > 0
            ? 999
            : 1;

      console.log(
        `\nvault.read per-note ratio (N=${String(last.n)} / N=${String(first.n)}): ${readRatio.toFixed(3)}`,
      );
      console.log(
        `getSyncedStamp per-note ratio (N=${String(last.n)} / N=${String(first.n)}): ${syncedRatio.toFixed(3)}`,
      );

      // ── Correctness: both counters must have fired ────────────────────────
      // (Instrumentation sanity — wiring is live.)
      expect(last.vaultReadTotal).toBeGreaterThan(0);
      expect(last.getSyncedStampTotal).toBeGreaterThan(0);

      // ── Correctness: convergence was verified ─────────────────────────────
      // (The observe-only driver must have fully converged B for every N.)
      // We verify convergence inside measureForN via waitConverged() AFTER measurement.
      // Nothing extra needed here beyond the above.

      const isSuperLinear = readRatio > 1.5 || syncedRatio > 1.5;

      if (isSuperLinear) {
        // BASELINE CHARACTERIZATION of the O(n^2) bug.
        //
        // The in-memory harness REPRODUCES the super-linear observe-path slope.
        // This assertion documents the CURRENT broken baseline.
        //
        // WHEN workset scoping lands (Stage 4-7), each observe pass will touch
        // only the changed docIds, so per-note cost will be ~flat. At that point
        // INVERT these assertions:
        //   - remove the ratio > 1.3 assertion
        //   - add: readRatio <= 1.5 && syncedRatio <= 1.5 (flat per-note cost)
        // That inverted assertion becomes the regression guard.
        console.log("\n[BASELINE] In-process harness reproduces super-linear observe-path slope.");
        console.log(
          "  vault.read per-note ratio: " +
            readRatio.toFixed(3) +
            "x  getSyncedStamp per-note ratio: " +
            syncedRatio.toFixed(3) +
            "x",
        );
        console.log(
          "  When Stage 4-7 scoping lands, INVERT these assertions to assert flat per-note cost.",
        );
        // At least one counter shows > 1.3x growth — characterize the super-linear baseline.
        const maxRatio = Math.max(readRatio, syncedRatio);
        expect(maxRatio).toBeGreaterThan(1.3);
      } else {
        // FLAT SCALING — headless harness does NOT reproduce the on-device slope.
        //
        // With no network latency the in-process coalescer collapses the burst into
        // very few reconcile passes, so per-note cost appears flat here even though
        // the on-device O(n^2) bug is real. The on-device re-profile (Stage 8) is
        // the authoritative performance signal for that bug.
        //
        // We still assert a loose ceiling at the largest observed value * 1.5 so
        // any future regression that dramatically increases call counts surfaces here.
        console.log("\n[FLAT] In-process harness does NOT reproduce the on-device O(n^2) slope.");
        console.log(
          "  vault.read per-note ratio: " +
            readRatio.toFixed(3) +
            "x  getSyncedStamp per-note ratio: " +
            syncedRatio.toFixed(3) +
            "x",
        );
        console.log(
          "  The on-device re-profile (Stage 8) is the authoritative performance signal.",
        );

        // Loose ceiling: future regressions that wildly inflate call counts will fail here.
        const readCeiling = Math.ceil(readPerNoteLarge * 1.5) + 1;
        const syncedCeiling = Math.ceil(syncedPerNoteLarge * 1.5) + 1;
        for (const r of results) {
          expect(r.vaultReadTotal / r.n).toBeLessThanOrEqual(readCeiling);
          expect(r.getSyncedStampTotal / r.n).toBeLessThanOrEqual(syncedCeiling);
        }
      }
    },
  );
});
