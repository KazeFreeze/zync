/**
 * Scenario — M4 (c) partial folder move while CLOSED, reconciled at bootstrap (over the real relay).
 *
 * Models an AI/terminal moving SOME children of a folder into a new folder while the app is closed:
 * the moves are per-FILE `mv`s (each a real rename syscall on a file), so — unlike a live directory
 * mv (characterized as skipped in folder-rename.test.ts) — bootstrap's `reconcileOfflineStructural`
 * sees each as a `lost` (live-in-index, disk-absent) paired with a `created` (on-disk, no index) and
 * RE-KEYS the docId via the shipped `matchRenames` core. This is the folder-scale exercise of the
 * shipped closed-app offline-rename path (offline-reconcile.test.ts proves the single-file case).
 *
 * Fixture `folder`: `notes/a.md|b.md|c.md` (unique prose) + `keep.md`. We move a.md + b.md into
 * `archive/`, leave c.md in `notes/`, and assert: the moved children re-key with docId continuity on
 * BOTH devices, c.md and keep.md are untouched, the old paths are gone, no wedge, no conflict.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  crash,
  device,
  heal,
  resetStack,
  restart,
  seedAndStart,
  vaultExec,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

describe("M4 partial offline folder move (per-file): bootstrap re-keys the moved children", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "folder");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("a closed-app partial folder move re-keys the moved children with continuity", async () => {
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    const aId = (await a.doc("notes/a.md")).docId;
    const bId = (await a.doc("notes/b.md")).docId;
    const cId = (await a.doc("notes/c.md")).docId;
    if (aId === null || bId === null || cId === null) throw new Error("seed docIds missing");
    expect((await b.doc("notes/a.md")).docId).toBe(aId);

    // ── App CLOSED: stop the engine (no watcher), move SOME children out-of-band into a NEW folder
    //    (per-FILE mv = real per-file rename events bootstrap reconciles), then cold-restart. ───────
    await a.stop();
    await vaultExec("device-a", ["mkdir", "-p", "/vault/archive"]);
    await vaultExec("device-a", ["mv", "/vault/notes/a.md", "/vault/archive/a.md"]);
    await vaultExec("device-a", ["mv", "/vault/notes/b.md", "/vault/archive/b.md"]);
    await crash("device-a"); // SIGKILL the engine-stopped container → force a fresh process
    await restart("device-a"); // recreate + wait healthy; boots IDLE
    await a.start(); // /sync/start → bootstrap → reconcileOfflineStructural

    await waitConverged(["device-a", "device-b"], { timeoutMs: 180_000 });

    // Moved children re-keyed with docId CONTINUITY on BOTH devices.
    expect((await a.doc("archive/a.md")).docId).toBe(aId);
    expect((await b.doc("archive/a.md")).docId).toBe(aId);
    expect((await a.doc("archive/b.md")).docId).toBe(bId);
    expect((await b.doc("archive/b.md")).docId).toBe(bId);

    // Unmoved child + the outside sibling are untouched; old moved paths are gone everywhere.
    const treeA = await a.tree();
    const treeB = await b.tree();
    expect(treeA["notes/c.md"]).toBeDefined();
    expect(treeB["notes/c.md"]).toBeDefined();
    expect((await b.doc("notes/c.md")).docId).toBe(cId);
    expect(treeA["keep.md"]).toBeDefined();
    expect(treeA["notes/a.md"]).toBeUndefined();
    expect(treeB["notes/a.md"]).toBeUndefined();
    expect(treeA["notes/b.md"]).toBeUndefined();

    // No spurious conflict; quiescent on both.
    expect((await a.status()).conflicts).toEqual([]);
    expect((await b.status()).conflicts).toEqual([]);
    expect((await a.status()).pendingDocs).toBe(0);
    expect((await b.status()).pendingDocs).toBe(0);
  }, 300_000);
});
