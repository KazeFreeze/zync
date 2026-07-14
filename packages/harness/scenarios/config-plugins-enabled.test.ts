/**
 * Scenario — config-plugins-enabled: enabled-list projection, ingest, local-only
 * preservation, and per-device suppress.
 *
 * The `pluginsEnabled` shared CRDT map is projected bidirectionally to
 * `.obsidian/community-plugins.json` on each device. These scenarios exercise:
 *
 *   1. enable on A → pluginsEnabled CRDT converges + community-plugins.json on B
 *   2. inbound: a native community-plugins.json edit on A ingests + propagates to B
 *   3. local-only id in B's community-plugins.json is preserved when A enables a managed plugin
 *   4. suppress on B: enabled-on-A stays OUT of B's list AND stays IN A's (no shared-disable leak)
 *
 * Prerequisites (set up in optIn helper):
 *   - Plugin bundle files must be written AND opted-in before calling pluginEnabled,
 *     because the engine ignores setPluginEnabled calls for ids not in pluginsOptIn.
 *   - configRescan() must be called after configWrite to force immediate detection.
 *
 * DO NOT call waitConverged for plugin assertions — community-plugins.json is in the
 * config zone (excluded from /fs/tree). Use waitBlobsSettled + communityList() polling.
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
  name: "Sample",
  version: "1.0.0",
  minAppVersion: "1.0.0",
});

/** Default main.js content. */
const MAIN = "module.exports = class {};\n";

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Write both required bundle files on `dev`, opt the plugin in, then force an
 * immediate rescan so the channel publishes without waiting for the watcher.
 */
async function optIn(dev: Device): Promise<void> {
  await dev.configWrite(`${DIR}/manifest.json`, MANIFEST);
  await dev.configWrite(`${DIR}/main.js`, MAIN);
  await dev.pluginOptIn(ID, true);
  await dev.configRescan();
}

/**
 * Poll `dev.communityList()` until `pred` returns true or the timeout elapses.
 * Throws with a diagnostic on timeout so failures are debuggable.
 */
async function waitCommunity(
  dev: Device,
  pred: (ids: string[]) => boolean,
  ms = 60_000,
): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const { enabled } = await dev.communityList();
    if (pred(enabled)) return;
    if (Date.now() > end) {
      throw new Error(
        `waitCommunity(${dev.name}) timed out after ${String(ms)}ms — ` +
          `last enabled=${JSON.stringify(enabled)}`,
      );
    }
    await sleep(500);
  }
}

// ── scenarios ────────────────────────────────────────────────────────────────

describe("config-plugins-enabled", () => {
  beforeEach(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterEach(async () => {
    await heal("device-a").catch(() => undefined);
    await heal("device-b").catch(() => undefined);
  });

  // ── 1. enable on A → pluginsEnabled + community-plugins.json on B ──────────

  it("enable on A -> pluginsEnabled + community-plugins.json on B", async () => {
    await optIn(a);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    await a.pluginEnabled(ID, true);
    await waitCommunity(b, (ids) => ids.includes(ID));
    expect((await b.communityList()).enabled).toContain(ID);
  }, 240_000);

  // ── 2. inbound: native edit on A ingests + propagates to B ─────────────────

  it("inbound: a native community-plugins.json edit on A ingests + propagates to B", async () => {
    await optIn(a);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    // Simulate a native Obsidian toggle: write community-plugins.json via CommunityPluginsPort.
    await a.communityWrite([ID]);
    await waitCommunity(b, (ids) => ids.includes(ID));
    expect((await b.communityList()).enabled).toContain(ID);
  }, 240_000);

  // ── 3. preserves a local-only plugin id in the peer's list ─────────────────

  it("preserves a local-only plugin id in the peer's community-plugins.json", async () => {
    // Pre-seed a local-only plugin on B before the managed plugin arrives.
    // communityWrite goes through CommunityPluginsPort (not ConfigPort, which rejects
    // out-of-zone paths) so the file is actually written.
    await b.communityWrite(["localonly"]);
    await optIn(a);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    await a.pluginEnabled(ID, true);
    await waitCommunity(b, (ids) => ids.includes(ID));
    // "localonly" must NOT be clobbered by the projection.
    expect((await b.communityList()).enabled).toContain("localonly");
  }, 240_000);

  // ── 4. suppress on B: stays out of B, stays in A (no shared-disable leak) ──

  it("suppress on B: enabled-on-A stays OUT of B's community-plugins.json AND does not disable on A", async () => {
    await optIn(a);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    await b.pluginSuppress(ID, true);
    await a.pluginEnabled(ID, true);
    // Give the CRDT time to converge and the projection to run on both sides.
    await sleep(5_000);
    // B suppresses it — must NOT appear in B's list.
    expect((await b.communityList()).enabled).not.toContain(ID);
    // A is not suppressed — must appear in A's list (no shared-disable leak).
    await waitCommunity(a, (ids) => ids.includes(ID));
    expect((await a.communityList()).enabled).toContain(ID);
  }, 240_000);

  // ── 5. opting in a RUNNING plugin propagates it as enabled (seed on opt-in) ─

  it("opting in a running plugin propagates it as enabled", async () => {
    // Simulate X already running on A: its enabled bit is present in community-plugins.json
    // BEFORE A consents to sync it. Opting in must SEED the shared enabled bit (from the listed
    // id) so X propagates to B as enabled — not get reprojected out because the bit was unset.
    await a.configWrite(`${DIR}/manifest.json`, MANIFEST);
    await a.configWrite(`${DIR}/main.js`, MAIN);
    await a.communityWrite([ID]); // X is already active/enabled on A
    await a.pluginOptIn(ID, true); // consent to sync -> seeds pluginsEnabled(ID)=true
    await a.configRescan();
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    // B projects the seeded enabled bit into its own community-plugins.json.
    await waitCommunity(b, (ids) => ids.includes(ID));
    expect((await b.communityList()).enabled).toContain(ID);
  }, 240_000);
});
