/**
 * Scenario — self-heal-pending: synced-stamp store loss is repaired by the F2
 * startup self-heal without any manual intervention.
 *
 * This directly models the user-reported issue: their `pendingDocs` count was stuck
 * at 1150 after a base-store wipe. The root cause: every live doc's stamp disappeared
 * from the durable state file, so `pendingDocs()` re-reported all of them as unseen.
 * The F2 startup self-heal (triggered at `engine.start()`) must drain `pendingDocs`
 * back to 0 autonomously — over the REAL relay — without any external change or manual
 * `requestSelfHeal` call.
 *
 * Test mechanics:
 *   1. Seed `mini` on A; B pulls it. Both converge (pendingDocs === 0).
 *   2. Stop A's sync engine (container stays up; control API remains reachable).
 *   3. Call `POST /engine/clear-synced-stamps` on A while the engine is stopped.
 *      The route calls `FsEngineStateStore.clearAllSyncedStamps()`, which clears the
 *      in-memory map AND atomically rewrites the state file — so the cleared state
 *      SURVIVES the next `engine.start()`.
 *   4. Start A's engine again. It loads the persisted (cleared) state, sees no synced
 *      stamps for any doc → every live doc is re-pending → the startup self-heal fires.
 *   5. Poll `GET /status` on A until `pendingDocs === 0` with NO manual flush call.
 *      Also assert the trees are unchanged / still converged with B.
 *
 * FAIL condition (without F2): after step 4, `pendingDocs` would stay non-zero forever
 * because the startup self-heal is not armed — the test would time out at step 5.
 *
 * NOTE: `stop()`/`start()` here stops the SYNC ENGINE only (POST /sync/stop|start);
 * the container stays up. `clearSyncedStamps()` works against the control API while
 * the engine is stopped, so no in-flight `setSyncedStamp` races the clear. This mirrors
 * the pattern used in config-conflict.test.ts for write-while-stopped operations.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  crashServer,
  device,
  resetStack,
  restartServer,
  seedAndStart,
  sleep,
  treesEqual,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

/**
 * Poll A's `pendingDocs` (via `GET /status`) until it reaches 0, with NO flush.
 * The self-heal fires on startup and must drain pending autonomously. Throws a
 * diagnostic error on timeout so the test never hangs.
 */
async function waitSelfHealDrained(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { pendingDocs, conn } = await a.status();
    if (pendingDocs === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitSelfHealDrained timed out after ${String(timeoutMs)}ms — ` +
          `A.pendingDocs=${String(pendingDocs)} conn=${conn}`,
      );
    }
    await sleep(1_000);
  }
}

/** Poll BOTH devices' `pendingDocs` until each reaches 0 (no flush). Throws a diagnostic on timeout. */
async function waitBothDrained(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [sa, sb] = await Promise.all([a.status(), b.status()]);
    if (sa.pendingDocs === 0 && sb.pendingDocs === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitBothDrained timed out after ${String(timeoutMs)}ms — ` +
          `A.pending=${String(sa.pendingDocs)} B.pending=${String(sb.pendingDocs)}`,
      );
    }
    await sleep(1_000);
  }
}

describe("self-heal-pending", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(() => {
    // No partition/heal levers used; nothing to clean up.
  });

  test("startup self-heal drains pendingDocs to 0 after synced-stamp store loss over the relay", async () => {
    // ── Phase 1: confirm initial convergence ──

    // Both devices must start fully quiescent (pendingDocs === 0) before we wipe stamps.
    const [initA, initB] = await Promise.all([a.status(), b.status()]);
    expect(initA.pendingDocs).toBe(0);
    expect(initB.pendingDocs).toBe(0);

    // Snapshot the converged tree to compare after the heal.
    const treeBeforeA = await a.tree();
    const treeBeforeB = await b.tree();
    expect(treesEqual(treeBeforeA, treeBeforeB)).toBe(true);
    // Confirm there is actual content to heal (the mini fixture has notes).
    const noteCount = Object.keys(treeBeforeA).length;
    expect(noteCount).toBeGreaterThan(0);

    // ── Phase 2: simulate synced-stamp loss that survives restart ──

    // Stop A's engine. The container + control API stay up.
    await a.stop();

    // Clear all synced stamps while the engine is stopped. The route calls
    // FsEngineStateStore.clearAllSyncedStamps() which flushes the cleared
    // state to disk atomically — the cleared state persists across the restart.
    await a.clearSyncedStamps();

    // Start A's engine again. It loads from the persisted (now-cleared) state file:
    // no synced stamps exist → every live doc is re-pending → the F2 startup
    // self-heal is armed and begins draining over the relay.
    await a.start();

    // Immediately after start, A should have a non-zero pendingDocs count (all the
    // notes that lost their stamps). We do NOT assert a specific number here because
    // the self-heal may have already begun draining by the time we read status, but
    // we verify this by checking convergence at the end.
    // (Asserting > 0 would be a TOCTOU race — the heal can beat the read.)

    // ── Phase 3: assert self-heal drains pendingDocs back to 0 (no manual flush) ──

    // Poll until A's pendingDocs reaches 0. NO flush is issued — the startup self-heal
    // must drain autonomously. A generous 120s covers a large relay round-trip under load.
    await waitSelfHealDrained(120_000);

    // After the self-heal, A's pendingDocs is 0.
    const finalA = await a.status();
    expect(finalA.pendingDocs).toBe(0);

    // ── Phase 4: assert no data loss — content unchanged and both devices converged ──

    const [treeAfterA, treeAfterB] = await Promise.all([a.tree(), b.tree()]);

    // A's tree matches B's tree: the self-heal did not corrupt any files.
    expect(treesEqual(treeAfterA, treeAfterB)).toBe(true);

    // A's tree is byte-for-byte identical to the pre-wipe snapshot: no data loss.
    expect(treesEqual(treeAfterA, treeBeforeA)).toBe(true);

    // B is still quiescent (the heal did not disturb B's state).
    const finalB = await b.status();
    expect(finalB.pendingDocs).toBe(0);
  }, 300_000);

  test("mid-session: reconnect re-arms self-heal on BOTH devices → drain to 0, no dup, no loss", async () => {
    // The MID-SESSION variant of the startup case: device-side synced-stamp loss WITHOUT a restart.
    // Nothing re-arms the change-driven reconcile loop, so the pending is wedged — a genuine reconnect
    // must re-arm the bounded self-heal (pending-gated) and drain BOTH devices back to 0 over the real
    // relay, converging with NO duplicated content (the concurrent-re-seed Yjs double-insert hazard).

    // ── Phase 1: both converged + quiescent ──
    const [initA, initB] = await Promise.all([a.status(), b.status()]);
    expect(initA.pendingDocs).toBe(0);
    expect(initB.pendingDocs).toBe(0);
    const treeBefore = await a.tree();
    expect(treesEqual(treeBefore, await b.tree())).toBe(true);
    const noteCount = Object.keys(treeBefore).length;
    expect(noteCount).toBeGreaterThan(0);

    // ── Phase 2: mid-session DEVICE-SIDE stamp loss + a genuine reconnect (relay reset) ──
    // A docker network `partition` does NOT close the client websocket (the socket stays "connected"),
    // so it cannot model a relay reset — the reconnect handler would never fire. CRASH the relay
    // (SIGKILL) so both clients see a genuine offline; clear each device's synced-stamp store while
    // offline (race-free — no acks in flight); then RESTART the relay (it reloads its persisted Yjs
    // snapshots, so no relay-side data loss) → both clients reconnect (offline→connected), and the
    // pending-gated reconnect self-heal arms and drains their now-pending docs.
    await crashServer();
    await sleep(4_000); // let both devices detect the dropped socket (offline) before clear + restart
    await a.clearSyncedStamps();
    await b.clearSyncedStamps();
    await restartServer();

    // ── Phase 3: both reconnect → the pending-gated reconnect self-heal drains (NO manual flush) ──
    await waitBothDrained(180_000);

    // ── Phase 4: no dup, no loss, converged ──
    const [treeAfterA, treeAfterB] = await Promise.all([a.tree(), b.tree()]);
    expect(treesEqual(treeAfterA, treeAfterB)).toBe(true); // converged
    expect(treesEqual(treeAfterA, treeBefore)).toBe(true); // no loss, no duplicated content
    expect(Object.keys(treeAfterA).length).toBe(noteCount); // exact same file set (no dup paths)
    const [finA, finB] = await Promise.all([a.status(), b.status()]);
    expect(finA.pendingDocs).toBe(0);
    expect(finB.pendingDocs).toBe(0);
  }, 360_000);
});
