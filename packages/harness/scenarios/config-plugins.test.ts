/**
 * Scenario — config-plugins: sync of community plugin code bundles via the
 * config channel, with opt-in gating, self-exclusion, and bundle-atomic conflict.
 *
 * The plugin channel shares the blob queue with themes/snippets and is EXCLUDED
 * from /fs/tree (NodeFsVault excludes the config zone), so:
 *   - DO NOT use waitConverged for plugin assertions (tree equality won't see them).
 *   - Use waitBlobsSettled for propagation, then device.read() for disk verification.
 *   - Use device.exists() for presence checks (read() throws on 404).
 *   - Always call configRescan() after configWrite/configRemove to force immediate
 *     detection instead of waiting on the watcher.
 *   - Call pluginOptIn(id, true) BEFORE configRescan when opting in — the gate must
 *     be open for the channel to publish the bundle files.
 *
 * Six scenarios:
 *   1. opted-in bundle materializes atomically on the peer
 *   2. non-opted-in bundle does NOT sync
 *   3. opt-out is non-destructive (peer keeps its copy)
 *   4. self-exclusion: zync plugin dir and data.json absent from configList
 *   5. bundle-atomic conflict: divergent main.js → one group inbox entry → keep-theirs converges
 *   6. isDesktopOnly mock-mobile (skipped: ZYNC_IS_MOBILE env not wired per-device; PluginGate
 *      unit test in packages/core/src/config/plugin-maps.test.ts covers the logic)
 *
 * CONFLICT DEVICE: LWW determines which side wins; the loser raises the conflict.
 * This is non-deterministic at test time, so waitConfigConflict polls BOTH devices
 * and returns whichever one holds the inbox entry — identical to the pattern in
 * config-conflict.test.ts. We resolve with "keep-theirs": the conflicting (LWW-loser)
 * device ADOPTS the winner's bytes, so both devices converge cleanly in a single resolve
 * with no residual conflict on either side. (keep-mine — loser bytes override the winner —
 * inherently ping-pongs a fresh conflict back to the peer; that engine branch is covered by
 * the @zync/crdt-yjs unit tests. This harness scenario's job is real-relay convergence +
 * bundle-atomic group detection, both exercised here by keep-theirs.)
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

const ID = "sample-plugin";
const DIR = `.obsidian/plugins/${ID}`;

/** A minimal but valid plugin manifest (no isDesktopOnly flag → desktop-allowed). */
const MANIFEST = JSON.stringify({
  id: ID,
  name: "Sample Plugin",
  version: "1.0.0",
  minAppVersion: "1.0.0",
});

/** Default main.js content used by the propagation / opt-out / self-exclusion tests. */
const MAIN = "module.exports = class SamplePlugin {};\n";

/** Distinct content written by device-a during the conflict test. */
const MAIN_A = "module.exports = class SamplePluginA {}; // device-a edit\n";

/** Distinct content written by device-b during the conflict test. */
const MAIN_B = "module.exports = class SamplePluginB {}; // device-b edit\n";

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Write both required bundle files on `dev`, opt the plugin in, then force an
 * immediate rescan so the channel publishes without waiting for the watcher.
 */
async function optInBundle(dev: Device, main = MAIN): Promise<void> {
  await dev.configWrite(`${DIR}/manifest.json`, MANIFEST);
  await dev.configWrite(`${DIR}/main.js`, main);
  await dev.pluginOptIn(ID, true);
  await dev.configRescan();
}

/**
 * Poll device-a then device-b until one has a kind==="config-file" inbox entry.
 * Returns the conflicting Device and the inbox entry id. Mirrors the same helper
 * in config-conflict.test.ts — uses dev.status().conflicts (the engine's inbox
 * surface through the control API /status endpoint).
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

// ── scenarios ────────────────────────────────────────────────────────────────

describe("config-plugins", () => {
  beforeEach(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterEach(async () => {
    // Heal any network partition left open by the conflict scenario.
    await heal("device-a").catch(() => undefined);
    await heal("device-b").catch(() => undefined);
  });

  // ── 1. opted-in bundle materialises atomically on the peer ──────────────

  it("opted-in bundle materializes atomically on the peer", async () => {
    await optInBundle(a);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Both required files must be present on device-b with matching content.
    expect(await b.read(`${DIR}/manifest.json`)).toBe(MANIFEST);
    expect(await b.read(`${DIR}/main.js`)).toBe(MAIN);
  }, 240_000);

  // ── 2. non-opted-in bundle does NOT sync ────────────────────────────────

  it("non-opted-in bundle does not sync to peer", async () => {
    // Write the bundle files and rescan — but deliberately skip pluginOptIn.
    await a.configWrite(`${DIR}/manifest.json`, MANIFEST);
    await a.configWrite(`${DIR}/main.js`, MAIN);
    await a.configRescan();

    // Give the system time to settle; the gate should block any propagation.
    await sleep(5_000);

    expect(await b.exists(`${DIR}/main.js`)).toBe(false);
  }, 240_000);

  // ── 3. opt-out is non-destructive: peer retains its copy ─────────────────

  it("opt-out is non-destructive: peer retains its copy after opt-out", async () => {
    // Phase 1: opt in and wait for device-b to receive the full bundle.
    await optInBundle(a);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    expect(await b.exists(`${DIR}/main.js`)).toBe(true);

    // Phase 2: opt out on device-a — device-b must keep its local materialised copy.
    await a.pluginOptIn(ID, false);
    await sleep(5_000);

    // Non-destructive: file must still be present on device-b.
    expect(await b.exists(`${DIR}/main.js`)).toBe(true);
  }, 240_000);

  // ── 4. self-exclusion ────────────────────────────────────────────────────

  it("self-exclusion: zync plugin dir and data.json absent from configList", async () => {
    // configList reflects the config map, which must never track zync's own files
    // or any plugin's data.json (both excluded by isConfigZone).
    const { files } = await a.configList();
    expect(files.filter((f) => f.path.startsWith(".obsidian/plugins/zync/"))).toHaveLength(0);
    expect(files.filter((f) => f.path.endsWith("/data.json"))).toHaveLength(0);
  }, 240_000);

  // ── 5. bundle-atomic conflict ─────────────────────────────────────────────

  it("bundle-atomic conflict: divergent main.js writes yield one group inbox entry, keep-theirs converges peer", async () => {
    // Phase 1: opt in on device-a with an initial main.js; wait for device-b to
    // receive and materialise the full bundle. Then opt device-b in so it participates
    // in the LWW race (gate allows it to publish its own edits on reconnect).
    await optInBundle(a, MAIN);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    expect(await b.exists(`${DIR}/main.js`)).toBe(true);
    await b.pluginOptIn(ID, true);

    // Phase 2: stop both engines, write DIFFERENT main.js bytes to each side,
    // then rescan (so bootstrap picks up the change on next start). This models
    // an offline edit on each device — neither engine sees the other's change
    // until they reconnect.
    await a.stop();
    await a.configWrite(`${DIR}/main.js`, MAIN_A);
    await a.configRescan();
    await a.start();

    await b.stop();
    await b.configWrite(`${DIR}/main.js`, MAIN_B);
    await b.configRescan();
    await b.start();

    // Phase 3: wait for the config-file conflict to surface on whichever device
    // lost the LWW race.
    const { dev: conflictDev, id } = await waitConfigConflict(120_000);

    // The conflict id MUST be the plugin group key (one entry for the whole bundle,
    // not one per file — bundle-atomic per Task 8 / config-group.ts).
    expect(id).toBe(`config-file:${DIR}/`);

    // Exactly one config-file conflict on the losing device.
    const conflictsBefore = (await conflictDev.status()).conflicts as { kind?: string }[];
    expect(conflictsBefore.filter((c) => c.kind === "config-file")).toHaveLength(1);

    // Phase 4: resolve keep-theirs on the conflicting (LWW-loser) device — it ADOPTS
    // the winner's bytes, so both devices converge cleanly in one resolve with no
    // residual conflict on either side.
    await conflictDev.configResolve(id, "keep-theirs");

    // Wait for blob propagation to settle on both sides after the group resolve.
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Both devices must converge to the same main.js bytes (the LWW-winner's copy).
    const contentA = await a.read(`${DIR}/main.js`);
    const contentB = await b.read(`${DIR}/main.js`);
    expect(contentA).toBe(contentB);

    // manifest.json (un-diverged) must also match on both sides.
    const manifestA = await a.read(`${DIR}/manifest.json`);
    const manifestB = await b.read(`${DIR}/manifest.json`);
    expect(manifestA).toBe(manifestB);

    // No residual config-file conflicts on either device.
    const aConflictsAfter = (await a.status()).conflicts as { kind?: string }[];
    const bConflictsAfter = (await b.status()).conflicts as { kind?: string }[];
    expect(aConflictsAfter.filter((c) => c.kind === "config-file")).toHaveLength(0);
    expect(bConflictsAfter.filter((c) => c.kind === "config-file")).toHaveLength(0);
  }, 240_000);

  // ── 6. isDesktopOnly mock-mobile (skipped) ───────────────────────────────

  it.skip("isDesktopOnly mock-mobile: desktop-only plugin not materialized on mobile peer", () => {
    // The per-device ZYNC_IS_MOBILE env wiring for a mock-mobile peer is not
    // exercised here; standing up a mobile-labelled device requires compose changes
    // that are out of scope for Slice 2a. The PluginGate unit test at
    // packages/core/src/config/plugin-maps.test.ts already proves the
    // optIn ∧ platformAllowed logic. Enable this scenario once ZYNC_IS_MOBILE
    // can be injected per-device via the compose seed path (Slice 2b candidate).
  });
});
