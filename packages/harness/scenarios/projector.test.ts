/**
 * Scenario — one-way projector (0b-3 Part C): a read-only projection SINK.
 *
 * `device-proj` runs with `ZYNC_INGEST_DISABLED=true`, which makes the engine's `onWrite`
 * early-return: it applies remote→disk (and bootstrap-seeds) but NEVER ingests its own
 * local writes, so it can never become a second write authority. This is what makes it
 * safe to co-locate a projector with the real vault: a file that lands in the projector's
 * vault propagates to NO other device.
 *
 * Two properties asserted over real containers:
 *   1. PROJECTION (remote→disk): A seeds + starts; the projector starts and materializes
 *      A's notes to its own `/vault-proj` — the projector's `/fs/tree` equals A's.
 *   2. NON-PROPAGATION (the sink property): a NEW file written DIRECTLY into the
 *      projector's vault (via its `/fs/write`) stays on the projector's disk but does NOT
 *      reach A — A's tree is UNCHANGED after convergence — and the projector's
 *      `ingestCount` stays 0 (the engine ingested nothing of its own).
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  device,
  resetStack,
  seedAndStart,
  sleep,
  treesEqual,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const proj = device("device-proj");

const PROJ_ONLY = "notes/proj-only.md";

beforeAll(async () => {
  await resetStack();
  // A seeds `mini`; the projector boots empty and PROJECTS it (remote→disk). seedAndStart
  // waits for A + projector to share one identical tree.
  await seedAndStart("device-a", ["device-proj"], "mini");
}, 180_000);

afterAll(async () => {
  // No partition lever; nothing to heal.
});

test("the projector projects A's notes to disk (remote→disk)", async () => {
  const treeA = await a.tree();
  const treeProj = await proj.tree();
  // The projector materialized A's full seeded vault to its own /vault-proj.
  expect(Object.keys(treeProj).length).toBeGreaterThan(0);
  expect(treesEqual(treeProj, treeA)).toBe(true);
  expect(treeProj["notes/alpha.md"]).toBeDefined();

  // It ingested nothing of its own (it only applied remote content) and wrote no CRDT.
  const status = await proj.status();
  expect(status.ingestCount).toBe(0);
});

test("a file written into the projector's vault propagates to NO other device (sink)", async () => {
  // Snapshot A's tree BEFORE the projector-local write.
  const treeABefore = await a.tree();
  expect(treeABefore[PROJ_ONLY]).toBeUndefined();

  // Write a brand-new file DIRECTLY into the projector's vault. With ingest disabled the
  // engine's onWrite early-returns, so this never becomes a CRDT/index entry to relay.
  await proj.write(PROJ_ONLY, "# projector-local\n\nWritten on the projector only.\n");

  // Give any (incorrect) propagation a generous window: flush both, then settle.
  for (let i = 0; i < 4; i++) {
    await proj.flush().catch(() => undefined);
    await a.flush().catch(() => undefined);
    await sleep(1000);
  }
  // A on its own must reach quiescence (it has no new work).
  await waitConverged(["device-a"], { timeoutMs: 60_000 });

  // The file IS on the projector's disk (the external write landed there)...
  expect((await proj.tree())[PROJ_ONLY]).toBeDefined();
  // ...but it did NOT propagate: A's tree is UNCHANGED — no proj-only.md, same key set.
  const treeAAfter = await a.tree();
  expect(treeAAfter[PROJ_ONLY]).toBeUndefined();
  expect(treesEqual(treeAAfter, treeABefore)).toBe(true);

  // The projector ingested nothing of its own even after the local write.
  expect((await proj.status()).ingestCount).toBe(0);
});
