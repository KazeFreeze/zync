/**
 * Scenario — two offline devices create the SAME daily note (Fable HIGH-2).
 *
 * ┌─ FIXED by the 0b-3 hardening pass — now an ACTIVE live gate (validated 2026-06-15) ───┐
 * │                                                                                       │
 * │ This scenario previously surfaced TWO real-relay bugs; BOTH are now resolved and the   │
 * │ scenario PASSES against the rebuilt (`--no-cache`) device image carrying Fixes 1–5.    │
 * │                                                                                        │
 * │ FINDING 1 (DATA-LOSS-grade — orphan NOT recovered over the real relay): when A & B      │
 * │   each created the SAME path offline with DIFFERENT content, the index `tree` LWW bound │
 * │   the path to ONE winner docId; the loser docId was orphaned but the sweep did NOT run  │
 * │   over the real relay, so the loser's content survived ONLY in the internal base store  │
 * │   — silent data loss. → FIXED by Fix 1 (`353f4db`): after-start creates now set         │
 * │   create-meta + a docStore snapshot, so the orphan sweep recovers the LWW loser to a    │
 * │   deterministic `… (conflict, <createdBy>, <createdTs>).md` recovery path.              │
 * │                                                                                        │
 * │ FINDING 2 (ASYMMETRIC pendingDocs latch on the loser device): the loser (A) latched     │
 * │   pendingDocs===1 forever while the winner settled. → No longer reproduces post-Fix;    │
 * │   both devices settle to pendingDocs===0 after the sweep materializes the loser.        │
 * │                                                                                        │
 * │ RESULT (2026-06-15, rebuilt image): A & B converge to ONE byte-identical tree; the live │
 * │   path holds the LWW winner; the loser is recovered to exactly one `(conflict, …)` path │
 * │   carrying the losing body; BOTH markers survive on BOTH devices; both quiescent         │
 * │   (pendingDocs===0). The assertions below now pass as a live gate.                       │
 * └───────────────────────────────────────────────────────────────────────────────────────┘
 *
 * INTENT (what this scenario asserts once the bugs are fixed):
 * A seeds `mini`; B boots empty and pulls it (single-seed onboarding). They converge.
 * Partition A. Offline, A creates `daily/2026-06-14.md` = "A content" while B creates the
 * SAME path = "B content". Heal. Both must converge so that NEITHER content is destroyed:
 * the index `tree` LWW binds the path to ONE winner docId; the loser docId is orphaned and
 * RECOVERED by the orphan sweep to a DETERMINISTIC `… (conflict, <createdBy>, <createdTs>).md`
 * path (a pure function of the doc's create-metadata, so every device computes the same path).
 *
 * The recovery path's `createdTs` token is real wall-clock metadata inside the container, so
 * we cannot predict the exact filename here. Instead we assert the PROPERTY that matters
 * (orphan-sweep.ts contract): BOTH texts survive SOMEWHERE on BOTH devices, the recovered
 * copy lands at a conflict path, and the two devices agree byte-for-byte (identical trees).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  conflictArtifacts,
  device,
  heal,
  partition,
  resetStack,
  seedAndStart,
  treesEqual,
  waitConverged,
  type Device,
  type Tree,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const PATH = "daily/2026-06-14.md";
const A_BODY = "# 2026-06-14 (authored by A)\n\nA content — created offline on device A.\n";
const B_BODY = "# 2026-06-14 (authored by B)\n\nB content — created offline on device B.\n";
const A_MARKER = "A content — created offline on device A.";
const B_MARKER = "B content — created offline on device B.";

describe("concurrent-create same daily note (LWW winner + recovered loser; validates the hardening fixes)", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("two offline creates of the same daily note both survive (LWW winner + recovered loser)", async () => {
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    // Partition A; each device CREATES the same path with DIFFERENT content offline.
    await partition("device-a");
    await a.write(PATH, A_BODY);
    await b.write(PATH, B_BODY);

    // Heal A and converge — the LWW winner stays at PATH; the loser is recovered via the sweep.
    await heal("device-a");
    await waitConverged(["device-a", "device-b"], { timeoutMs: 120_000 });

    const treeA = await a.tree();
    const treeB = await b.tree();

    // Both devices agree byte-for-byte (winner + recovered loser are identical across devices).
    expect(treesEqual(treeA, treeB)).toBe(true);

    // The live PATH holds ONE of the two bodies (whichever won LWW).
    const live = await a.read(PATH);
    const winnerIsA = live.includes(A_MARKER);
    const winnerIsB = live.includes(B_MARKER);
    expect(winnerIsA || winnerIsB).toBe(true);

    // The loser was RECOVERED to a conflict path — not destroyed. Exactly one such artifact.
    const recovered = conflictArtifacts(treeA);
    expect(recovered.length).toBe(1);
    const recoveredPath = recovered[0];
    expect(recoveredPath).toBeDefined();
    if (recoveredPath === undefined) return;

    // BOTH texts survive SOMEWHERE on BOTH devices: the winner at PATH, the loser at the
    // recovered path (identical bytes across devices — guaranteed by tree equality above).
    for (const d of [a, b]) {
      const allText = await collectText(d.name === "device-a" ? treeA : treeB, d);
      expect(allText.includes(A_MARKER)).toBe(true);
      expect(allText.includes(B_MARKER)).toBe(true);
    }

    // The recovered copy carries the LOSING body (the one NOT at the live path).
    const recoveredText = await a.read(recoveredPath);
    if (winnerIsA) {
      expect(recoveredText).toContain(B_MARKER);
    } else {
      expect(recoveredText).toContain(A_MARKER);
    }

    // Both devices quiescent.
    expect((await a.status()).pendingDocs).toBe(0);
    expect((await b.status()).pendingDocs).toBe(0);
  });
});

/** Concatenate the text of every file in `tree` (read via the device's control API). */
async function collectText(tree: Tree, d: Device): Promise<string> {
  const parts: string[] = [];
  for (const path of Object.keys(tree)) {
    parts.push(await d.read(path));
  }
  return parts.join("\n");
}
