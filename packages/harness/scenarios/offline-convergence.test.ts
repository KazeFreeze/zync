/**
 * Scenario 1 — offline convergence (DISJOINT edits).
 *
 * A seeds `mini`; B boots empty and pulls it (single-seed onboarding — see
 * {@link seedAndStart}). They converge. Partition A. While A is offline:
 *   - A appends to notes/alpha.md,
 *   - B appends to notes/beta.md (a DIFFERENT file).
 * Heal A. Both must converge to one identical tree carrying BOTH edits, with
 * ZERO conflict artifacts (disjoint changes never conflict).
 *
 * `resetStack()` recreates the stack so this scenario starts from a pristine relay
 * + empty vaults, independent of any prior scenario's leftover doc state.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  conflictArtifacts,
  device,
  heal,
  partition,
  resetStack,
  seedAndStart,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

beforeAll(async () => {
  await resetStack();
  await seedAndStart("device-a", ["device-b"], "mini");
}, 180_000);

afterAll(async () => {
  // Best-effort heal so a failed run never leaves A stranded off syncnet.
  await heal("device-a").catch(() => undefined);
});

test("disjoint offline edits merge with zero conflict artifacts", async () => {
  await partition("device-a");

  await a.edit({ path: "notes/alpha.md", append: "\nAdded on A while offline.\n" });
  await b.edit({ path: "notes/beta.md", append: "\nAdded on B while A is offline.\n" });

  await heal("device-a");

  await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

  const treeA = await a.tree();
  const treeB = await b.tree();

  // Both edits present everywhere.
  const alphaA = await a.read("notes/alpha.md");
  const alphaB = await b.read("notes/alpha.md");
  const betaA = await a.read("notes/beta.md");
  const betaB = await b.read("notes/beta.md");

  expect(alphaA).toContain("Added on A while offline.");
  expect(alphaB).toContain("Added on A while offline.");
  expect(betaA).toContain("Added on B while A is offline.");
  expect(betaB).toContain("Added on B while A is offline.");

  // Zero conflict artifacts on either device.
  expect(conflictArtifacts(treeA)).toEqual([]);
  expect(conflictArtifacts(treeB)).toEqual([]);

  // And zero conflict-inbox entries (the disjoint-edit clean-merge property).
  expect((await a.status()).conflicts).toEqual([]);
  expect((await b.status()).conflicts).toEqual([]);
});
