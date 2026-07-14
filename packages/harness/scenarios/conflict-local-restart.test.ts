/**
 * Scenario — conflict artifact stays DEVICE-LOCAL across an engine restart.
 *
 * A seeds `mini`; B boots empty and pulls it (single-seed onboarding). They converge.
 * Then A manufactures a genuine 3-way same-line conflict (IDENTICAL mechanism to
 * same-line-conflict.test.ts) → A parks a conflict artifact under `_conflicts/…`,
 * and the inbox entry syncs to B.
 *
 * THEN — the NEW coverage that none of the other conflict scenarios exercise:
 *
 *   A's sync engine is STOPPED and STARTED again (`a.stop()` / `a.start()`). This
 *   forces a full bootstrap re-scan. Before the `_conflicts/` exclusion was wired into
 *   `classify`, this re-bootstrap would re-classify the artifact as prose, mint a new
 *   docId for it, and publish it to B — i.e. the artifact would APPEAR in B's tree on
 *   the next sync. After the fix the artifact is permanently excluded from the sync
 *   surface regardless of how many times the engine restarts.
 *
 * ASSERTIONS (post-restart):
 *   - `conflictArtifacts(a.tree())` still has exactly 1 entry (A still holds its copy).
 *   - `conflictArtifacts(b.tree())` is EMPTY — the restart did NOT push it to B.
 *   - B's normal prose content (notes/alpha.md) is unchanged / still converged with A.
 *
 * NOTE: stop()/start() here stops the SYNC ENGINE only (POST /sync/stop|start); the
 * container stays up. This models the restart path (app relaunch / engine re-init) that
 * triggers a fresh bootstrap scan — the original bug's trigger surface.
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
 * Poll until BOTH devices are quiescent (`pendingDocs === 0`), the SURVIVING alpha.md
 * is byte-identical across devices, and the conflict has converged to BOTH inboxes.
 * Mirrors the same helper in same-line-conflict.test.ts.
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

/**
 * Poll until BOTH devices are quiescent and alpha.md is byte-identical across devices.
 * Used post-restart: we do NOT require full tree equality (A still holds the local
 * artifact; B does not) — we only assert prose-level convergence here.
 */
async function waitReconverged(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all([a.flush().catch(() => undefined), b.flush().catch(() => undefined)]);

    const [sa, sb, treeA, treeB] = await Promise.all([a.status(), b.status(), a.tree(), b.tree()]);
    const alphaA = treeA["notes/alpha.md"]?.sha256;
    const alphaB = treeB["notes/alpha.md"]?.sha256;

    const reconverged =
      sa.pendingDocs === 0 && sb.pendingDocs === 0 && alphaA !== undefined && alphaA === alphaB;
    if (reconverged) return;

    if (Date.now() >= deadline) {
      throw new Error(
        `waitReconverged timed out after ${String(timeoutMs)}ms\n` +
          `  A: pendingDocs=${String(sa.pendingDocs)} alpha=${String(alphaA).slice(0, 12)}\n` +
          `  B: pendingDocs=${String(sb.pendingDocs)} alpha=${String(alphaB).slice(0, 12)}`,
      );
    }
    await sleep(500);
  }
}

describe("conflict artifact — device-local across engine restart", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("conflict artifact is NOT re-published to peer after A's engine restarts", async () => {
    // ── Phase 1: manufacture a same-line conflict on A (mirrors same-line-conflict.test.ts) ──

    // Open an editor on A → the note's CRDT becomes active-bound.
    await a.editorOpen("notes/alpha.md");

    // Diverge the CRDT from base on the STATUS line without touching disk.
    const before = (await a.doc("notes/alpha.md")).text;
    const valueAt = before.indexOf("pristine");
    expect(valueAt).toBeGreaterThanOrEqual(0);
    await a.editorType({
      path: "notes/alpha.md",
      at: valueAt,
      del: "pristine".length,
      ins: "edited-in-editor",
    });

    // Racing external write to the SAME line: merge3(base=pristine, disk=DISK_SIDE,
    // crdt=CRDT_SIDE) → NON-clean → one conflict artifact + one inbox entry on A.
    await a.edit({ path: "notes/alpha.md", find: ANCHOR, replace: DISK_SIDE });

    // Wait for both devices to settle: alpha.md converged + inbox synced to B.
    await waitConflictSettled(90_000);

    // Confirm the artifact exists on A (device-local) and NOT on B.
    const artifactsA_before = conflictArtifacts(await a.tree());
    const artifactsB_before = conflictArtifacts(await b.tree());
    expect(artifactsA_before).toHaveLength(1);
    expect(artifactsB_before).toHaveLength(0);

    // Confirm the inbox entry reached B (synced-inbox property).
    const conflictsA_before = (await a.status()).conflicts as {
      id: string;
      artifactPath?: string;
    }[];
    const conflictsB_before = (await b.status()).conflicts as {
      id: string;
      artifactPath?: string;
    }[];
    expect(conflictsA_before).toHaveLength(1);
    expect(conflictsB_before).toEqual(conflictsA_before);

    // ── Phase 2: RESTART A's sync engine (the new coverage) ──

    // Stop then immediately re-start A's sync engine — same stop/start the
    // config-conflict scenario uses. This triggers a full bootstrap re-scan.
    // Before the _conflicts/ classification exclusion this caused the artifact
    // to be re-classified as prose and published to B.
    await a.stop();
    await a.start();

    // Allow the re-bootstrapped engine to re-converge with B.
    await waitReconverged(90_000);

    // ── Phase 3: assert artifact is STILL device-local after the restart ──

    // A still holds its local copy of the conflict artifact.
    const artifactsA_after = conflictArtifacts(await a.tree());
    expect(artifactsA_after).toHaveLength(1);
    // The artifact path is unchanged.
    expect(artifactsA_after[0]).toBe(artifactsA_before[0]);

    // B's tree is STILL free of conflict artifacts — the restart bootstrap did NOT
    // re-publish the artifact to B. This assertion would FAIL before the fix.
    const artifactsB_after = conflictArtifacts(await b.tree());
    expect(artifactsB_after).toHaveLength(0);

    // B's normal prose content (alpha.md) is unchanged / still converged with A.
    const winnerA = await a.read("notes/alpha.md");
    const winnerB = await b.read("notes/alpha.md");
    expect(winnerA).toEqual(winnerB);
    expect(winnerA).toContain(CRDT_SIDE);
  }, 240_000);
});
