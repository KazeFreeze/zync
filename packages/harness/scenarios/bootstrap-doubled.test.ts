/**
 * Scenario — bootstrap + doubled-content landmine (over the real relay).
 *
 * A seeds `mini` + starts. B boots EMPTY and adopts the SAME content by PULLING from the
 * relay (single-seed onboarding — NOT by loading the fixture independently, which would
 * mint a SECOND docId per path and turn every note into a spurious concurrent-create
 * conflict). B must converge to A's EXACT trees with NO doubled content (no note's body
 * is duplicated) and ZERO spurious conflict artifacts / inbox entries.
 *
 * This is the over-the-network analogue of the in-process doubled-content landmine guard
 * (bootstrap-concurrent-create + engine-integration Scenario 5): a follower adopting
 * server docs never re-seeds them, so content is never doubled.
 */

import { beforeAll, expect, test } from "vitest";
import {
  conflictArtifacts,
  device,
  resetStack,
  seedAndStart,
  treesEqual,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const NOTES = [
  "notes/alpha.md",
  "notes/beta.md",
  "notes/multi.md",
  "daily/2026-06-13.md",
  "projects/x/plan.md",
];

beforeAll(async () => {
  await resetStack();
  // A seeds + starts; B boots empty and pulls A's content over the relay.
  await seedAndStart("device-a", ["device-b"], "mini");
}, 180_000);

test("B adopts A's content via the relay with no doubled content or spurious artifacts", async () => {
  await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

  const treeA = await a.tree();
  const treeB = await b.tree();

  // B's tree EXACTLY equals A's (same paths, same content sha) — full adoption.
  expect(treesEqual(treeA, treeB)).toBe(true);

  // Every seeded note is present on B and BYTE-IDENTICAL to A's copy.
  for (const p of NOTES) {
    expect(treeB[p]).toBeDefined();
    const textA = await a.read(p);
    const textB = await b.read(p);
    expect(textB).toEqual(textA);
  }

  // NO doubled content: the seeded fixtures have a unique opening line; it must appear
  // EXACTLY ONCE in each adopted note (a re-seed would concatenate/duplicate the body).
  const heads: Record<string, string> = {
    "notes/alpha.md": "# Alpha",
    "notes/beta.md": "# Beta",
    "notes/multi.md": "LINE-ONE original",
    "projects/x/plan.md": "# Project X — Plan",
  };
  for (const [p, head] of Object.entries(heads)) {
    const text = await b.read(p);
    expect(occurrences(text, head)).toBe(1);
  }

  // ZERO spurious conflict artifacts (no re-seed concurrent-create) and EMPTY inboxes.
  expect(conflictArtifacts(treeA)).toEqual([]);
  expect(conflictArtifacts(treeB)).toEqual([]);
  expect((await a.status()).conflicts).toEqual([]);
  expect((await b.status()).conflicts).toEqual([]);
});

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}
