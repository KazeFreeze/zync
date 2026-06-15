/**
 * Scenario — divergent local copy → supervised import (over the real relay).
 *
 * A seeds `mini` + starts + converges (the relay now holds A's `notes/alpha.md`). B then
 * loads the `mini-divergent` fixture — a vault containing ONLY `notes/alpha.md` whose body
 * DIFFERS from A's — and starts sync. B has a DIVERGENT local copy of a path the relay also
 * has, with NO base: the bootstrap routes to a SUPERVISED IMPORT.
 *
 * Contract (mirrors supervised-import.ts + engine-structural Task 3 M1):
 *   1. B ADOPTS the server's alpha.md as the live note (never a silent overwrite, never a
 *      merge3-blended hybrid) → B's alpha.md becomes byte-identical to A's.
 *   2. B PARKS its divergent local draft as a deterministic conflict artifact (present on B).
 *   3. B surfaces EXACTLY ONE `supervised-import` inbox entry pointing at that artifact.
 *
 * NOTE the asymmetry vs. a detected merge conflict: the supervised-import artifact + inbox
 * entry are LOCAL to the importing device (B). A neither imports nor parks anything; its
 * alpha.md is untouched. So we assert tree convergence on the SURVIVING alpha.md (modulo
 * B's local artifact), not full tree equality.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  conflictArtifacts,
  device,
  heal,
  resetStack,
  sleep,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const ALPHA = "notes/alpha.md";

interface InboxEntry {
  id: string;
  kind: string;
  path?: string;
  artifactPath?: string;
}

/**
 * Poll until B has run its supervised import: the live alpha.md matches A's, B holds one
 * conflict artifact, and B surfaces one `supervised-import` inbox entry. Drives `/sync/flush`
 * each round (the quiescence lever) so a latched intermediate stamp is re-read. Bounded;
 * throws a diagnostic on timeout so it never hangs.
 */
async function waitSupervisedImport(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all([a.flush().catch(() => undefined), b.flush().catch(() => undefined)]);

    const [treeA, treeB, sb] = await Promise.all([a.tree(), b.tree(), b.status()]);
    const alphaA = treeA[ALPHA]?.sha256;
    const alphaB = treeB[ALPHA]?.sha256;
    const sup = (sb.conflicts as InboxEntry[]).filter((e) => e.kind === "supervised-import");
    const artifacts = conflictArtifacts(treeB);

    if (
      alphaA !== undefined &&
      alphaA === alphaB &&
      sup.length === 1 &&
      artifacts.length === 1 &&
      sb.pendingDocs === 0
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitSupervisedImport timed out after ${String(timeoutMs)}ms\n` +
          `  alphaA=${String(alphaA).slice(0, 12)} alphaB=${String(alphaB).slice(0, 12)}\n` +
          `  B supervised-import entries=${String(sup.length)} artifacts=${String(artifacts.length)} pending=${String(sb.pendingDocs)}`,
      );
    }
    await sleep(500);
  }
}

beforeAll(async () => {
  await resetStack();
  // A seeds `mini` + starts + converges so the relay holds A's alpha.md.
  await a.loadFixture("mini");
  await a.start();
  await waitConverged(["device-a"], { timeoutMs: 60_000 });

  // B loads ONLY the divergent alpha.md, THEN starts sync (the cardinal onboarding flow:
  // a pre-existing divergent local copy of a path the relay already has).
  await b.loadFixture("mini-divergent");
  await b.start();
}, 180_000);

afterAll(async () => {
  await heal("device-b").catch(() => undefined);
});

test("B's divergent copy routes to supervised import: adopt server, park local, one inbox entry", async () => {
  await waitSupervisedImport(120_000);

  // 1. B adopted A's server alpha.md as the live note (byte-identical across devices),
  //    never B's draft, never a blended merge.
  const liveA = await a.read(ALPHA);
  const liveB = await b.read(ALPHA);
  expect(liveB).toEqual(liveA);
  expect(liveB).toContain("# Alpha");
  expect(liveB).not.toContain("divergent-local-draft");

  // 2. B parked its divergent draft as EXACTLY ONE conflict artifact, content preserved.
  const artifactsB = conflictArtifacts(await b.tree());
  expect(artifactsB.length).toBe(1);
  const artifactPath = artifactsB[0];
  expect(artifactPath).toBeDefined();
  if (artifactPath === undefined) return;
  const artifactText = await b.read(artifactPath);
  expect(artifactText).toContain("DIVERGENT local draft");
  expect(artifactText).toContain("STATUS: divergent-local-draft");

  // 3. EXACTLY ONE supervised-import inbox entry on B, pointing at the artifact.
  const supB = (await b.status()).conflicts as InboxEntry[];
  const supEntries = supB.filter((e) => e.kind === "supervised-import");
  expect(supEntries.length).toBe(1);
  expect(supEntries[0]?.path).toBe(ALPHA);
  expect(supEntries[0]?.artifactPath).toBe(artifactPath);

  // The artifact is LOCAL to the importing device — A neither parks it nor sees it as a file.
  expect(conflictArtifacts(await a.tree())).toEqual([]);
});
