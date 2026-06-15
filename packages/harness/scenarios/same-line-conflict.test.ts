/**
 * Scenario 2 — same-line conflict (a divergent SAME-line edit → artifact + synced inbox).
 *
 * A seeds `mini`; B boots empty and pulls it (single-seed onboarding). They converge.
 * Then A produces a genuine 3-way conflict on the SAME `STATUS:` line of notes/alpha.md:
 * its CRDT (via a live editor) and its disk (via an external writer) each rewrite that
 * line DIFFERENTLY from the common base, so `merge3(base, disk, crdt)` goes NON-clean and
 * the ingest emits a conflict artifact + a synced-inbox entry. Both devices then settle to
 * the SAME winning alpha.md, and the conflict entry converges to BOTH inboxes.
 *
 * WHY A DETERMINISTIC EDITOR-DRIVEN TRIGGER (not a relay race):
 *
 *   A conflict ARTIFACT is the product of the 3-way ingest merge `merge3(base, disk, crdt)`
 *   going NON-clean — disk and crdt diverge from a common base on the SAME line. Driving
 *   that via TWO devices racing the SAME line over a real async relay is timing-
 *   NONDETERMINISTIC: most interleavings land a clean LWW (the Yjs text CRDT concatenates
 *   char-level edits) and produce NO artifact. An earlier version of this scenario looped up
 *   to 8 relay-race attempts hunting for an artifact-producing interleaving and reliably
 *   FAILED to find one — convergence was clean every round.
 *
 *   So we make the trigger DETERMINISTIC and LOCAL on device A: OPEN an editor on the note
 *   (its CRDT becomes active-bound) and type a divergent value into the `STATUS:` line via
 *   `/editor/type` (the CRDT now diverges from base; disk/base still pristine), THEN issue a
 *   racing EXTERNAL `/fs/edit` to the SAME line. The external write is ingested while the
 *   editor's divergent text is the `crdt` arm of `merge3(base, disk, crdt)`, forcing a
 *   guaranteed non-clean merge → one artifact + one inbox entry on A.
 *
 * WHAT CONVERGES TO B (and what does NOT):
 *
 *   The conflict is SURFACED to B through the SYNCED inbox, which lives on the always-
 *   attached index doc (a per-entry-LWW `CrdtMap<InboxEntry>` keyed by a deterministic id),
 *   so A's inbox entry relays to B and BOTH `/status` inboxes carry the SAME conflict. The
 *   conflict ARTIFACT FILE itself, however, does NOT replicate as a file: `writeConflict-
 *   Artifact` echo-guards its own write (the artifact is never re-ingested → never minted an
 *   index docId), so the artifact file is a LOCAL parking of the loser on the device that
 *   DETECTED the conflict. A peer that did not locally detect the same conflict learns of it
 *   via the synced inbox entry's `artifactPath`, NOT via the file appearing in its tree.
 *   This mirrors the canonical in-process engine test (engine-integration Scenario 3), which
 *   asserts the conflict on BOTH INBOXES and the converged winner — never tree-level artifact
 *   replication. We therefore assert tree convergence on the SURVIVING note (modulo A's local
 *   artifact file), not full tree equality.
 *
 * WHAT THE LATCH FIX UNBLOCKED:
 *
 *   The original blocker was a core-engine convergence bug (commit 78f7751): under a
 *   conflict-merge's multi-bump sequence, `LazyAttachManager.runCatchUp` latched the doc's
 *   synced stamp against a STALE catch-up snapshot, leaving the authoring device
 *   `pendingDocs === 1` FOREVER even though content had converged. The fix records the synced
 *   stamp from the doc's ACTUAL current content hash, so a conflict-merge now SETTLES — the
 *   `pendingDocs === 0` waits below would otherwise hang on the authoring device.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  conflictArtifacts,
  device,
  heal,
  resetStack,
  seedAndStart,
  sleep,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const ANCHOR = "STATUS: pristine";
const CRDT_SIDE = "STATUS: edited-in-editor";
const DISK_SIDE = "STATUS: edited-on-disk";

/**
 * Poll until BOTH devices are quiescent (`pendingDocs === 0` — the property the latch fix
 * restores on the authoring side), the SURVIVING alpha.md is byte-identical across devices,
 * and the conflict has converged to BOTH synced inboxes. Drives `/sync/flush` each poll
 * (the same quiescence lever {@link waitConverged} uses) so a latched intermediate stamp is
 * re-read. Bounded; throws a diagnostic on timeout so it never hangs.
 */
async function waitConflictSettled(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all([a.flush().catch(() => undefined), b.flush().catch(() => undefined)]);

    const [sa, sb, treeA, treeB] = await Promise.all([a.status(), b.status(), a.tree(), b.tree()]);
    const alphaA = treeA["notes/alpha.md"]?.sha256;
    const alphaB = treeB["notes/alpha.md"]?.sha256;

    const settled =
      sa.pendingDocs === 0 &&
      sb.pendingDocs === 0 &&
      alphaA !== undefined &&
      alphaA === alphaB &&
      sa.conflicts.length >= 1 &&
      sb.conflicts.length >= 1;
    if (settled) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `waitConflictSettled timed out after ${String(timeoutMs)}ms\n` +
          `  A: pendingDocs=${String(sa.pendingDocs)} conflicts=${String(sa.conflicts.length)} alpha=${String(alphaA).slice(0, 12)}\n` +
          `  B: pendingDocs=${String(sb.pendingDocs)} conflicts=${String(sb.conflicts.length)} alpha=${String(alphaB).slice(0, 12)}`,
      );
    }
    await sleep(500);
  }
}

describe("same-line conflict", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("a same-line 3-way conflict yields one artifact + synced inbox on both devices", async () => {
    // Open an editor on A → the note's CRDT becomes active-bound (the editor's text is now
    // the `crdt` arm of the ingest merge). Disk + base are still the pristine anchor.
    await a.editorOpen("notes/alpha.md");

    // Locate the anchor VALUE ("pristine") in the live CRDT text and replace it via the
    // editor, so the CRDT diverges from base on the STATUS line WITHOUT touching disk.
    const before = (await a.doc("notes/alpha.md")).text;
    const valueAt = before.indexOf("pristine");
    expect(valueAt).toBeGreaterThanOrEqual(0);
    await a.editorType({
      path: "notes/alpha.md",
      at: valueAt,
      del: "pristine".length,
      ins: "edited-in-editor",
    });

    // Racing EXTERNAL write to the SAME line → disk diverges from base differently. The
    // ingest now runs merge3(base=pristine, disk=DISK_SIDE, crdt=CRDT_SIDE) → NON-clean →
    // emitConflict: the disk side is kept as a conflict artifact + an inbox entry is added.
    await a.edit({ path: "notes/alpha.md", find: ANCHOR, replace: DISK_SIDE });

    // The latch fix lets the authoring device settle; the winner + inbox entry reach B.
    await waitConflictSettled(90_000);

    // The conflict artifact exists on the DETECTING device (A) — the artifact is echo-
    // guarded so it never replicates as a FILE; the peer learns of it via the synced inbox.
    const artifactsA = conflictArtifacts(await a.tree());
    expect(artifactsA.length).toBe(1);
    const artifactPath = artifactsA[0];
    expect(artifactPath).toBeDefined();
    if (artifactPath === undefined) return;

    // The artifact preserves the losing (disk) side.
    const artifactText = await a.read(artifactPath);
    expect(artifactText).toContain(DISK_SIDE);

    // The surviving alpha.md holds the winning (CRDT) side and agrees across devices.
    const winnerA = await a.read("notes/alpha.md");
    const winnerB = await b.read("notes/alpha.md");
    expect(winnerA).toEqual(winnerB);
    expect(winnerA).toContain(CRDT_SIDE);

    // The conflict is surfaced in BOTH devices' inboxes (the synced-inbox property: the
    // inbox is a CrdtMap on the always-attached index doc that relays over the transport).
    // BOTH inboxes carry the SAME deterministic entry, naming A's artifact path.
    const conflictsA = (await a.status()).conflicts as { id: string; artifactPath?: string }[];
    const conflictsB = (await b.status()).conflicts as { id: string; artifactPath?: string }[];
    expect(conflictsA.length).toBe(1);
    expect(conflictsB).toEqual(conflictsA);
    expect(conflictsA[0]?.artifactPath).toBe(artifactPath);
  });
});
