/**
 * Scenario 3 — quiescence (no relay ping-pong / false-quiescence guard).
 *
 * A seeds `mini`; B boots empty and pulls it (single-seed onboarding). After the
 * clean convergence, the system must be QUIESCENT: every device pendingDocs === 0,
 * trees equal, conn connected, and re-polling /status a few times shows NO churn
 * (writeCount + ingestCount stable). This guards against a relay echo loop that
 * would keep re-ingesting its own writes forever.
 */

import { beforeAll, expect, test } from "vitest";
import {
  device,
  resetStack,
  seedAndStart,
  sleep,
  treesEqual,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

beforeAll(async () => {
  await resetStack();
  await seedAndStart("device-a", ["device-b"], "mini");
}, 180_000);

test("converged system stays quiescent across repeated /status polls", async () => {
  // Reaffirm a clean converge.
  await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

  const treeA0 = await a.tree();
  const treeB0 = await b.tree();
  expect(treesEqual(treeA0, treeB0)).toBe(true);

  const s0a = await a.status();
  const s0b = await b.status();

  expect(s0a.pendingDocs).toBe(0);
  expect(s0b.pendingDocs).toBe(0);
  expect(s0a.conn).toBe("connected");
  expect(s0b.conn).toBe("connected");

  // Poll a few more times with no input — counters must NOT move (no ping-pong).
  for (let i = 0; i < 4; i++) {
    await sleep(1_500);
    const sa = await a.status();
    const sb = await b.status();

    expect(sa.pendingDocs).toBe(0);
    expect(sb.pendingDocs).toBe(0);
    expect(sa.writeCount).toBe(s0a.writeCount);
    expect(sb.writeCount).toBe(s0b.writeCount);
    expect(sa.ingestCount).toBe(s0a.ingestCount);
    expect(sb.ingestCount).toBe(s0b.ingestCount);
    expect(sa.conn).toBe("connected");
    expect(sb.conn).toBe("connected");
  }

  // Trees still equal and unchanged after the quiescence window.
  expect(treesEqual(await a.tree(), treeA0)).toBe(true);
  expect(treesEqual(await b.tree(), treeB0)).toBe(true);
});
