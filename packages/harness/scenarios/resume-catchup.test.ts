/**
 * Scenario — work made behind a SILENT link drains on its own after the link returns.
 *
 * THE GAP THIS CLOSES. The engine re-pushes dirty docs on reconnect, but only when a `connected`
 * status FOLLOWS an `offline`/`unauthorized` one — the transport maps `offline` solely from
 * `WebSocketStatus.Disconnected`. Every existing partition scenario produces that clean edge,
 * because `partition()` refuses the connection outright.
 *
 * A silent link does not necessarily produce it. Android 14+ freezes a backgrounded Obsidian
 * process, and on resume the plugin calls `transport.kick()`; if the socket never reported a clean
 * disconnect, the "did we go offline?" latch stays false, the reconnect catch-up never runs, and
 * the pending-gated self-heal never arms. The user-visible result is a status bar stuck on a
 * non-zero pending count that only a manual re-verify or a restart clears.
 *
 * `blackhole()` is the right lever precisely because it is NOT `partition()`: the host stays
 * reachable-but-silent so requests hang, which is what a frozen process and a dead-but-unclosed
 * socket both look like from the engine's side.
 *
 * DELIBERATELY NO `reflush()`. The manual re-verify command already exists and would make this
 * pass while proving nothing. The property under test is that recovery is AUTOMATIC.
 */

import { beforeAll, expect, test } from "vitest";
import {
  blackhole,
  device,
  resetStack,
  seedAndStart,
  sleep,
  treesEqual,
  unblackhole,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

/** Long enough that the engine cannot treat the gap as a momentary blip. */
const SILENT_LINK_MS = 20_000;

beforeAll(async () => {
  await resetStack();
  await seedAndStart("device-a", ["device-b"], "mini");
}, 180_000);

test("edits made while the link is silent drain automatically once it returns", async () => {
  // B goes reachable-but-silent. No clean disconnect is guaranteed from here.
  await blackhole("device-b");

  // Both sides do real work while B cannot reach the relay. Different paths, so this is a
  // catch-up test, not a merge test — a conflict here would confuse the signal.
  await b.write("notes/from-b.md", "written while the link was silent\n");
  await a.write("notes/from-a.md", "written while B was away\n");

  await sleep(SILENT_LINK_MS);
  await unblackhole("device-b");

  // No reflush, no restart: the engine must notice on its own. Generous bound because the
  // reconnect heal is jittered per device.
  await waitConverged(["device-a", "device-b"], { timeoutMs: 120_000 });

  const treeA = await a.tree();
  const treeB = await b.tree();
  expect(treesEqual(treeA, treeB)).toBe(true);

  // Both directions: B's offline write must reach A, and A's must reach B.
  expect(await a.read("notes/from-b.md")).toContain("written while the link was silent");
  expect(await b.read("notes/from-a.md")).toContain("written while B was away");

  // The visible symptom of a catch-up that never armed is pending that never returns to zero:
  // nothing left to send, and nothing still expected inbound.
  const statusB = await b.status();
  expect(statusB.pendingDocs).toBe(0);
  expect(statusB.sending).toBe(0);
  expect(statusB.arriving).toBe(0);
}, 300_000);
