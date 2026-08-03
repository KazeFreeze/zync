/**
 * Scenario — the arriving count is honest over a real relay.
 *
 * Device A authors a set of notes; device B receives them. The count MUST reach zero at
 * convergence, and the existing convergence contract must be unchanged.
 *
 * DELIBERATELY NOT ASSERTED: "arriving > 0 mid-arrival". Prose materialization can complete inside
 * a single pass, so sampling for a transient non-zero is a race against a real relay. That property
 * is pinned deterministically in packages/crdt-yjs/test/engine-sync-snapshot.test.ts instead, which
 * converges a doc onto device B and then removes the materialized file from B's disk WITHOUT marking
 * it dirty — reproducing the not-yet-materialized shape of an inbound note without racing a real
 * transport. A flaky harness assertion is worse than none: a false red is as corrosive as a false
 * green.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { device, resetStack, waitConverged } from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const NOTES = 12;

beforeAll(async () => {
  await resetStack();
  await a.start();
  await b.start();
}, 120_000);

afterAll(async () => {
  await a.stop();
  await b.stop();
});

test("arriving drains to zero and the partition sums to pending", async () => {
  for (let i = 0; i < NOTES; i++) {
    await a.write(`notes/arrive-${String(i)}.md`, `body ${String(i)}`);
  }
  await waitConverged(["device-a", "device-b"], { timeoutMs: 300_000 });

  for (const d of [a, b]) {
    const s = await d.status();
    expect(s.arriving).toBe(0);
    expect(s.pendingDocs).toBe(0);
    expect(s.sending).toBe(0);
  }

  // B genuinely received the content (guards against "0 arriving" being right by accident
  // because B never learned about the notes at all).
  expect(await b.read("notes/arrive-0.md")).toBe("body 0");
  expect(Object.keys(await b.tree())).toHaveLength(NOTES);
}, 300_000);
