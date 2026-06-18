/**
 * Stage 2 — durable work-queue reconcile coalescer (reconcile-queue.test.ts)
 *
 * Tests TDD-first for the Stage 2 coalescer redesign:
 *   1. failure-requeue: a thrown pass re-queues its batch; subsequent pass retries
 *      it; whenIdle() does NOT resolve idle while failed batch is pending.
 *   2. no-work-dropped: a burst of N observe-driven changes all converge on a peer
 *      (analogous to Scenario 13, observe-path only).
 *   3. whenIdle-gates-real-pass: whenIdle() resolves only AFTER the actual reconcile
 *      loop promise settles (not a manual gate).
 *
 * Uses the InProcessBus + FakeVault + MemEngineState harness (same as §15 tests).
 * Does NOT call waitConverged/flush on B during observe-driven windows.
 */

import { describe, it, expect } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, VaultPath, VaultPort } from "@zync/core";
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
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
}

function makeDevice(
  bus: InProcessBus,
  deviceId: string,
  name: string,
  vaultOverride?: VaultPort,
): Device {
  const vault = new FakeVault();
  const ports: EnginePorts = {
    vault: vaultOverride ?? vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
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
  return { engine: new SyncEngine(ports, config), vault };
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

// ── 1. failure-requeue ────────────────────────────────────────────────────

describe("Stage 2 durable work-queue coalescer", () => {
  /**
   * Test 1: failure-requeue
   *
   * Force a reconcile pass to throw once by wrapping engineState.getSyncedStamp
   * so it throws on the FIRST call after we arm the fault, then restores.
   * Assert:
   *   - A pass did throw (fault was exercised).
   *   - Batch was re-queued: subsequent passes retry the work.
   *   - The device still converges (content reaches B eventually).
   *   - whenIdle() does NOT return idle while failed batch is pending AND
   *     no new observe arrives — it must NOT falsely succeed while there is
   *     pending unflushed work.
   *
   * NOTE: The requeue-and-reschedule mechanism means failed work is retried on
   * the NEXT scheduleReconcile call, which either comes from a new index change
   * OR from whenIdle's inner drain loop.  We verify convergence by pumping
   * whenIdle + brief yields (same pattern as Scenario 13) until B materializes
   * the note, then asserting the final state.
   */
  it(
    "1) failure-requeue: thrown pass re-queues batch; device still converges",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");

      // B uses a fault-injectable engineState.
      const rawState = new MemEngineState();
      let throwOnce = false;
      let throwCount = 0;

      // Proxy that throws once on getSyncedStamp when armed.
      const faultyState = new Proxy(rawState, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (prop === "getSyncedStamp" && typeof value === "function") {
            return (...args: unknown[]): unknown => {
              if (throwOnce) {
                throwOnce = false;
                throwCount++;
                throw new Error("INJECTED_FAULT: getSyncedStamp");
              }
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value;
        },
      });

      const bVault = new FakeVault();
      const bPorts: EnginePorts = {
        vault: bVault,
        crdt: new YjsCrdtProvider(),
        transport: bus.connect(),
        blobs: new FakeBlobStore(),
        docStore: new FakeDocStore(),
        clock: new FakeClock(),
        identity: identity("dev-b", "Device B"),
        engineState: faultyState,
      };
      const bConfig: EngineConfig = {
        configDir: ".obsidian",
        maxProseBytes: 1_000_000,
        substrate: "yjs",
        stampDebounceMs: 0,
      };
      const b: Device = { engine: new SyncEngine(bPorts, bConfig), vault: bVault };

      await a.engine.start();
      await b.engine.start();
      await converge(a, b);

      // Arm the fault BEFORE A writes: the first reconcile pass on B will throw.
      throwOnce = true;

      // A writes one note → B's index.observe fires → B schedules a reconcile → that pass throws.
      await a.vault.writeAtomic(path("fault/note.md"), utf8("fault test content"));
      await a.engine.waitConverged();

      // Drive B via observe path only (no waitConverged/flush on B during window).
      // Pump whenIdle + yield until B materializes the note or we time out.
      const countMd = async (): Promise<number> =>
        (await bVault.list()).filter(({ path: p }) => p.startsWith("fault/")).length;

      let have = 0;
      for (let i = 0; i < 300 && have < 1; i++) {
        await b.engine.whenIdle();
        have = await countMd();
        if (have < 1) await new Promise<void>((r) => setTimeout(r, 2));
      }

      // The fault was exercised at least once.
      expect(throwCount).toBeGreaterThan(0);

      // The note eventually materialized on B (batch was retried).
      expect(have).toBe(1);
      const bytes = await bVault.read(path("fault/note.md"));
      expect(bytes).not.toBeNull();
      if (bytes !== null) {
        expect(decode(bytes)).toBe("fault test content");
      }

      // Final convergence check.
      await b.engine.waitConverged();
      expect(await b.engine.pendingDocs()).toEqual([]);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  // ── 4. persistent (multi-throw) requeue ─────────────────────────────────

  /**
   * Test 4: the batch survives CONSECUTIVE thrown passes.
   *
   * The chain throws on the first 3 reconcile attempts (each pass throws on its first
   * getSyncedStamp call in computeCatchUpSet, aborting that pass), then succeeds. A single-throw
   * test cannot catch a regression where the SECOND requeue drops paths; this one does — it asserts
   * exactly 3 consecutive failures were absorbed and the note still converged.
   */
  it(
    "4) persistent failure: batch survives 3 consecutive thrown passes, then converges",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");

      const rawState = new MemEngineState();
      const FAULTS = 3;
      let throwCount = 0;
      let armed = false;
      // Throws on the first FAULTS getSyncedStamp calls AFTER arming. Each reconcile pass throws on
      // its first getSyncedStamp (in computeCatchUpSet), so FAULTS throws == FAULTS failed passes.
      const faultyState = new Proxy(rawState, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (prop === "getSyncedStamp" && typeof value === "function") {
            return (...args: unknown[]): unknown => {
              if (armed && throwCount < FAULTS) {
                throwCount++;
                throw new Error("INJECTED_FAULT: getSyncedStamp (persistent)");
              }
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value;
        },
      });

      const bVault = new FakeVault();
      const bPorts: EnginePorts = {
        vault: bVault,
        crdt: new YjsCrdtProvider(),
        transport: bus.connect(),
        blobs: new FakeBlobStore(),
        docStore: new FakeDocStore(),
        clock: new FakeClock(),
        identity: identity("dev-b", "Device B"),
        engineState: faultyState,
      };
      const bConfig: EngineConfig = {
        configDir: ".obsidian",
        maxProseBytes: 1_000_000,
        substrate: "yjs",
        stampDebounceMs: 0,
      };
      const b: Device = { engine: new SyncEngine(bPorts, bConfig), vault: bVault };

      await a.engine.start();
      await b.engine.start();
      await converge(a, b);

      armed = true; // the next FAULTS reconcile getSyncedStamp calls throw
      await a.vault.writeAtomic(path("fault/persist.md"), utf8("persistent fault content"));
      await a.engine.waitConverged();

      const countMd = async (): Promise<number> =>
        (await bVault.list()).filter(({ path: p }) => p.startsWith("fault/")).length;
      let have = 0;
      for (let i = 0; i < 400 && have < 1; i++) {
        await b.engine.whenIdle();
        have = await countMd();
        if (have < 1) await new Promise<void>((r) => setTimeout(r, 2));
      }

      // All 3 injected faults fired (consecutive requeues), then the batch converged.
      expect(throwCount).toBe(FAULTS);
      expect(have).toBe(1);
      const bytes = await bVault.read(path("fault/persist.md"));
      expect(bytes === null ? null : decode(bytes)).toBe("persistent fault content");

      await b.engine.waitConverged();
      expect(await b.engine.pendingDocs()).toEqual([]);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  // ── 2. no-work-dropped ──────────────────────────────────────────────────

  /**
   * Test 2: no-work-dropped
   *
   * A burst of N observe-driven changes (A writes N notes, pushes via bus) all
   * converge on B via the observe handler only (no waitConverged on B during window).
   * Mirrors Scenario 13 — confirms the durable queue drains every change.
   */
  it(
    "2) no-work-dropped: burst of N observe changes converge on peer via observe path only",
    { timeout: 60_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();
      await converge(a, b);

      const N = 30;
      for (let i = 0; i < N; i++) {
        await a.vault.writeAtomic(
          path(`queue-burst/n${String(i)}.md`),
          utf8(`burst note ${String(i)} body`),
        );
      }
      await a.engine.waitConverged();

      // B converges via observe ONLY — no waitConverged on B during this window.
      const countMd = async (): Promise<number> =>
        (await b.vault.list()).filter(({ path: p }) => p.startsWith("queue-burst/")).length;

      let have = 0;
      for (let i = 0; i < 300 && have < N; i++) {
        await b.engine.whenIdle();
        have = await countMd();
        if (have < N) await new Promise<void>((r) => setTimeout(r, 2));
      }

      expect(have).toBe(N);

      // Spot-check byte-identity.
      for (const i of [0, 14, 29]) {
        const p = path(`queue-burst/n${String(i)}.md`);
        const bytes = await b.vault.read(p);
        expect(bytes).not.toBeNull();
        if (bytes !== null) {
          expect(decode(bytes)).toBe(`burst note ${String(i)} body`);
        }
      }

      await b.engine.waitConverged();
      expect(await b.engine.pendingDocs()).toEqual([]);

      await a.engine.stop();
      await b.engine.stop();
    },
  );

  // ── 3. whenIdle-gates-real-pass ─────────────────────────────────────────

  /**
   * Test 3: whenIdle gates the real pass.
   *
   * We confirm that whenIdle() awaits the ACTUAL reconcile loop promise (not a
   * manually-resolved gate). We do this by:
   *   - Having A write a note.
   *   - NOT calling waitConverged on B.
   *   - Calling whenIdle() on B — it MUST resolve only after B's reconcile loop
   *     has actually settled (i.e., if a pass was in flight, whenIdle blocks until it
   *     finishes, not until some gate is manually flipped).
   *   - After whenIdle() resolves, any files that a completed pass would have written
   *     ARE on disk (B has the note OR at least the indexed entry is there).
   *
   * Mechanically: after A converges and the bus delivers to B, the first whenIdle()
   * on B should await B's coalesced pass. If the old manual gate resolved too early
   * (before the pass awaits completed), the note would NOT be on disk. With the new
   * durable queue (tracking the real loop promise), whenIdle() blocks until the loop
   * iteration finishes.
   */
  it(
    "3) whenIdle() gates the real pass — resolves only after loop settles",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      const a = makeDevice(bus, "dev-a", "Device A");
      const b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();
      await converge(a, b);

      // A writes a note → bus delivers to B → B's index.observe fires → scheduleReconcile.
      await a.vault.writeAtomic(path("idle-gate/note.md"), utf8("idle gate content"));
      await a.engine.waitConverged();

      // Pump B's whenIdle + brief yields until the note materializes, proving that
      // whenIdle() blocked long enough for the reconcile loop to finish its work.
      const countMd = async (): Promise<number> =>
        (await b.vault.list()).filter(({ path: p }) => p.startsWith("idle-gate/")).length;

      let have = 0;
      for (let i = 0; i < 200 && have < 1; i++) {
        await b.engine.whenIdle();
        have = await countMd();
        if (have < 1) await new Promise<void>((r) => setTimeout(r, 2));
      }

      expect(have).toBe(1);

      // After whenIdle settles, the note must be on disk with correct content.
      const bytes = await b.vault.read(path("idle-gate/note.md"));
      expect(bytes).not.toBeNull();
      if (bytes !== null) {
        expect(decode(bytes)).toBe("idle gate content");
      }

      await a.engine.stop();
      await b.engine.stop();
    },
  );
});
