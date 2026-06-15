/**
 * Scenario — three-way merge (DISJOINT lines of the SAME note).
 *
 * ┌─ SKIPPED: surfaces a genuine engine convergence bug over the REAL relay ─────────────┐
 * │                                                                                       │
 * │ FINDING (clean disjoint 3-way merge → SYMMETRIC pendingDocs latch / false non-        │
 * │   quiescence): after the disjoint merge the CONTENT converges PERFECTLY — both         │
 * │   devices' `/fs/tree` is BYTE-FOR-BYTE IDENTICAL (notes/multi.md sha matches on A & B),│
 * │   both edits present everywhere, ZERO conflict artifacts, EMPTY inboxes. The MERGE IS  │
 * │   CORRECT. BUT BOTH devices then report `pendingDocs === 1` FOREVER (durable across    │
 * │   repeated `/sync/flush` → `engine.waitConverged` → 50 catch-up rounds), so the        │
 * │   harness's convergence primitive never returns. This is the same false-quiescence     │
 * │   LATCH class as the documented commit 78f7751 (recorded in same-line-conflict's        │
 * │   header), now surfacing on the CLEAN disjoint-merge path AND SYMMETRICALLY (both       │
 * │   authoring devices latch, not just one) over the real async relay.                     │
 * │                                                                                         │
 * │ EVIDENCE (reproduced 2x against real containers, post-failure probe of both devices):   │
 * │   A /status → pendingDocs=1 conflicts=0 conn=connected                                   │
 * │   B /status → pendingDocs=1 conflicts=0 conn=connected                                   │
 * │   A & B /fs/tree  multi.md → 5de81bfb0586 (IDENTICAL); all 5 paths agree                 │
 * │   For EVERY live doc on A: /doc contentSha256 == baseHash == tree sha (fully            │
 * │     reconciled — content==base==disk), fsm=inactive, attachedDocs=5 on both.            │
 * │   Repeated `/sync/flush` returns {converged:false, pendingDocs:1} every time → the      │
 * │     synced-stamp is latched at an intermediate merge hash that never re-advances to     │
 * │     the converged tree stamp, even though `pendingDocs`'s every input (entry.stamp,     │
 * │     disk hash, base) already equals the converged content.                              │
 * │                                                                                         │
 * │ The in-process analogue (engine-integration Scenario 1, "offline-both-sides → heal →    │
 * │ converge keeps disjoint edits, ZERO artifacts") ASSERTS `pendingDocs === []` and PASSES │
 * │ — the multi-bump relay sequence that latches the synced stamp only arises over the      │
 * │ REAL async relay (the FakeBus delivers updates synchronously, so the stale-snapshot     │
 * │ window the lazy-attach STALE-SNAPSHOT-LATCH note describes never opens). This is the     │
 * │ over-the-real-network divergence the harness exists to surface.                          │
 * │                                                                                         │
 * │ PER THE HARNESS CONTRACT we do NOT patch the engine; this is a valuable surfaced bug     │
 * │ feeding the planned engine-hardening pass. Skipped (not deleted) so the contract it      │
 * │ encodes — a clean disjoint 3-way merge reaches FULL quiescence (pendingDocs===0) on      │
 * │ BOTH devices — flips green the moment the latch hardening lands.                          │
 * └───────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ RESIDUAL after the 0b-3 hardening pass (Fixes 1–5) — RE-CONFIRMED, STILL SKIPPED ─────┐
 * │ Re-ran against the rebuilt (`--no-cache`) device image carrying ALL of Fixes 1–5,       │
 * │ including Fix 5 (`81418f0`, dirty-clear/synced-advance gated on a relay ack). The latch  │
 * │ PERSISTS — Fix 5 did NOT resolve it; it is the SEPARATE "re-stamp on full agreement"     │
 * │ fix (Root 1C / Fix 6) that is still needed.                                              │
 * │                                                                                          │
 * │ EVIDENCE (2026-06-15, rebuilt image, this scenario run in isolation):                    │
 * │   A /status → {conn:connected, pendingDocs:1, conflicts:[]}                              │
 * │   B /status → {conn:connected, pendingDocs:1, conflicts:[]}   (SYMMETRIC — both latch)   │
 * │   A & B /fs/tree  notes/multi.md → 5de81bfb05860260 (BYTE-IDENTICAL across devices)      │
 * │   A & B /doc(notes/multi.md) → contentSha==baseHash==tree sha (5de81bfb…), fsm=inactive  │
 * │     — fully reconciled (content==base==disk) on BOTH sides, yet pendingDocs stays 1      │
 * │       forever across repeated `/sync/flush`. The CONTENT merge is correct (both edits    │
 * │       present, zero artifacts); only the synced-stamp never re-advances to the converged │
 * │       tree stamp. This is precisely the Fix-6 / Root 1C class. Dispatch Fix 6 to flip it.│
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * INTENT (what this scenario asserts once the bug is fixed):
 * A seeds `mini`; B boots empty and pulls it (single-seed onboarding). They converge.
 * The note `notes/multi.md` is force-ATTACHED on BOTH devices (open+close an editor)
 * so the shared Y.Text exists on each side BEFORE the partition — the in-process
 * analogue (engine-integration Scenario 1) relies on the doc being attached on both
 * sides so that offline disk edits flow into the CRDT and merge on heal.
 *
 * Partition A. Offline, A rewrites LINE 1 and B rewrites LINE 3 (DISJOINT lines of the
 * same note). Heal. Both converge to ONE byte-identical tree carrying BOTH edits, with
 * ZERO conflict artifacts and EMPTY inboxes — the clean three-way merge (no same-line
 * divergence, so `merge3` stays clean).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  conflictArtifacts,
  device,
  heal,
  partition,
  resetStack,
  seedAndStart,
  sleep,
  treesEqual,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const NOTE = "notes/multi.md";
const LINE1_FROM = "LINE-ONE original";
const LINE1_TO = "LINE-ONE edited-by-A";
const LINE3_FROM = "LINE-THREE original";
const LINE3_TO = "LINE-THREE edited-by-B";

/**
 * Poll until the disjoint three-way merge has fully SETTLED: both devices quiescent,
 * the note byte-identical across devices, AND it carries BOTH edits. A plain tree-
 * equality wait is insufficient here — mid-merge the two trees can TRANSIENTLY agree on
 * an INTERMEDIATE state (e.g. one side has briefly adopted the other's pre-merge copy)
 * with pendingDocs momentarily 0, so we additionally gate on the CONTENT invariant (both
 * edits present) before returning. Drives `/sync/flush` each round (the quiescence lever);
 * bounded, throws a diagnostic on timeout so it never hangs.
 */
async function waitBothEditsMerged(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all([a.flush().catch(() => undefined), b.flush().catch(() => undefined)]);

    const [sa, sb, noteA, noteB] = await Promise.all([
      a.status(),
      b.status(),
      a.read(NOTE),
      b.read(NOTE),
    ]);
    const merged =
      sa.pendingDocs === 0 &&
      sb.pendingDocs === 0 &&
      noteA === noteB &&
      noteA.includes(LINE1_TO) &&
      noteA.includes(LINE3_TO);
    if (merged) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `waitBothEditsMerged timed out after ${String(timeoutMs)}ms\n` +
          `  A: pending=${String(sa.pendingDocs)} hasA=${String(noteA.includes(LINE1_TO))} hasB=${String(noteA.includes(LINE3_TO))}\n` +
          `  B: pending=${String(sb.pendingDocs)} hasA=${String(noteB.includes(LINE1_TO))} hasB=${String(noteB.includes(LINE3_TO))}`,
      );
    }
    await sleep(500);
  }
}

describe("three-way merge (clean disjoint 3-way merge → full quiescence — Fix-6 clean-settle landed)", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("disjoint-line offline edits to one note clean-merge with zero artifacts", async () => {
    // Force-attach the note on BOTH devices so the shared CRDT exists before partition.
    // Opening an editor drives `ensureNoteAttached`; closing leaves the doc attached.
    await a.editorOpen(NOTE);
    await b.editorOpen(NOTE);
    await a.editorClose(NOTE);
    await b.editorClose(NOTE);
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    // Partition A; both sides edit DISJOINT lines of the SAME note offline.
    await partition("device-a");
    await a.edit({ path: NOTE, find: LINE1_FROM, replace: LINE1_TO });
    await b.edit({ path: NOTE, find: LINE3_FROM, replace: LINE3_TO });

    // Heal and settle on the CONTENT invariant (both edits present), not just tree-equality
    // — the merge can transiently agree on an intermediate state mid-converge.
    await heal("device-a");
    await waitBothEditsMerged(90_000);

    const treeA = await a.tree();
    const treeB = await b.tree();

    // Full tree equality — a clean merge leaves NO local-only artifact on either side.
    expect(treesEqual(treeA, treeB)).toBe(true);

    // BOTH edits present on BOTH devices, and the note is byte-identical across devices.
    const noteA = await a.read(NOTE);
    const noteB = await b.read(NOTE);
    expect(noteA).toEqual(noteB);
    expect(noteA).toContain(LINE1_TO);
    expect(noteA).toContain(LINE3_TO);
    // The untouched middle line survives unchanged.
    expect(noteA).toContain("stable middle line");

    // ZERO conflict artifacts and EMPTY inboxes — the clean three-way-merge property.
    expect(conflictArtifacts(treeA)).toEqual([]);
    expect(conflictArtifacts(treeB)).toEqual([]);
    expect((await a.status()).conflicts).toEqual([]);
    expect((await b.status()).conflicts).toEqual([]);
  });
});
