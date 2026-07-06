/**
 * Scenario — config-conflict: divergent offline config writes create a config-file
 * conflict entry in the inbox; resolving with keep-theirs converges both devices.
 *
 * Pattern mirrors conflict-resolve.test.ts's makeConflict stop/write/start approach:
 *   1. Stop each device, write different bytes to the SAME snippet path, rescan, restart.
 *   2. The config-sync layer detects the divergence and raises a kind="config-file"
 *      conflict entry on whichever device lost the LWW race.
 *   3. Call configResolve(id, "keep-theirs") on the conflicting device.
 *   4. waitBlobsSettled confirms both devices converge to the winning bytes.
 *   5. Assert both devices have identical content and no residual config-file conflicts.
 *
 * WHICH DEVICE CONFLICTS: LWW determines which device's bytes win; the loser raises
 * the conflict. This is non-deterministic at test time (both devices reconnect roughly
 * simultaneously), so waitConfigConflict polls BOTH devices and returns the one that
 * has the entry.
 *
 * NOTE: stop()/start() here stops the SYNC ENGINE (POST /sync/stop|start), not the
 * container. The config write via configWrite() goes through the control API (which
 * stays up while the engine is stopped). configRescan() while stopped is intentional —
 * it forces an immediate disk scan so the engine picks up the new bytes on the next
 * start without waiting for the watcher.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  device,
  heal,
  resetStack,
  seedAndStart,
  sleep,
  waitBlobsSettled,
  type Device,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const SNIPPET_PATH = ".obsidian/snippets/tweaks.css";

/**
 * Poll device-a then device-b each iteration until one has a conflict entry with
 * kind === "config-file". Returns the conflicting Device and the conflict id.
 * Throws a diagnostic error on timeout so the test never hangs.
 */
async function waitConfigConflict(timeoutMs: number): Promise<{ dev: Device; id: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const dev of [a, b]) {
      const conflicts = (await dev.status()).conflicts as { id: string; kind?: string }[];
      const entry = conflicts.find((c) => c.kind === "config-file");
      if (entry !== undefined) return { dev, id: entry.id };
    }
    if (Date.now() >= deadline) {
      const [aConflicts, bConflicts] = await Promise.all([
        a.status().then((s) => s.conflicts),
        b.status().then((s) => s.conflicts),
      ]);
      throw new Error(
        `waitConfigConflict timed out after ${String(timeoutMs)}ms — ` +
          `a.conflicts=${JSON.stringify(aConflicts)} ` +
          `b.conflicts=${JSON.stringify(bConflicts)}`,
      );
    }
    await sleep(500);
  }
}

describe("config-conflict", () => {
  beforeEach(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterEach(async () => {
    await heal("device-a").catch(() => undefined);
    await heal("device-b").catch(() => undefined);
  });

  it("config-file conflict: divergent offline writes detected, resolved with keep-theirs", async () => {
    // Create a true first-sync divergence: each device writes different bytes
    // to the same snippet path while its engine is stopped (offline-style).
    // The config-sync layer detects the mismatch on reconnect and raises a conflict.
    await a.stop();
    await a.configWrite(SNIPPET_PATH, "/* MINE */");
    await a.configRescan();
    await a.start();

    await b.stop();
    await b.configWrite(SNIPPET_PATH, "/* THEIRS */");
    await b.configRescan();
    await b.start();

    // Wait for the config-file conflict to surface on whichever device lost LWW.
    const { dev: conflictDev, id } = await waitConfigConflict(120_000);

    // Resolve: keep-theirs → the remote/winning bytes win on the conflicting device.
    await conflictDev.configResolve(id, "keep-theirs");

    // Wait for the blob queue to settle on both sides (post-resolve convergence).
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Both devices must have the same snippet content on disk.
    const contentA = await a.read(SNIPPET_PATH);
    const contentB = await b.read(SNIPPET_PATH);
    expect(contentA).toBe(contentB);

    // No residual config-file conflict entry on either device.
    const aConflicts = (await a.status()).conflicts as { kind?: string }[];
    const bConflicts = (await b.status()).conflicts as { kind?: string }[];
    expect(aConflicts.filter((c) => c.kind === "config-file")).toHaveLength(0);
    expect(bConflicts.filter((c) => c.kind === "config-file")).toHaveLength(0);
  }, 240_000);
});
