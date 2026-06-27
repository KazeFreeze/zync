/**
 * Scenario — M1b offline reconciliation (over the real relay + real filesystem).
 *
 * Models changes made to a device's vault while the app/plugin was CLOSED (an AI/terminal `rm`/`mv` in
 * the vault dir, bypassing the engine + watcher). On the next `/sync/start` these are seen ONLY by
 * bootstrap's `reconcileOfflineStructural` pre-pass:
 *   - an offline DELETE → on a DURABLE adapter (NodeFsVault) the delete PROPAGATES (peers remove the
 *     file) — M1b. (On Obsidian, non-durable, it is held for one-tap confirm; covered in-process, since
 *     a real FS directory walk cannot under-report like getFiles() can.)
 *   - an offline RENAME → the docId is re-keyed to the new path (continuity) and the move replicates.
 *
 * This is the harness gate for M1b: the in-process suite + fuzzer prove convergence, but the real
 * recursive `fs.watch` + real relay + real FsDocStore/BaseStore are only exercised here.
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

const MOVE_FROM = "notes/alpha.md";
const MOVE_TO = "notes/alpha-moved.md";
const DELETED = "notes/beta.md";

describe("M1b offline reconciliation (closed-app rm propagates over the real relay; rename re-keys)", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("a closed-app delete propagates; a closed-app rename keeps docId continuity", async () => {
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    // docId of the to-be-moved note BEFORE (single seed → same docId on both devices).
    const docIdBefore = (await a.doc(MOVE_FROM)).docId;
    expect(docIdBefore).not.toBeNull();
    expect((await b.doc(MOVE_FROM)).docId).toBe(docIdBefore);

    // ── Simulate "app closed": stop the engine (watcher off), mutate the vault OUT-OF-BAND, then
    //    cold-restart a FRESH daemon process so bootstrap re-scans the durable volume. ───────────
    await a.stop(); // engine.stop() → no watcher; the container stays up so we can exec into it.
    await vaultExec("device-a", ["rm", `/vault/${DELETED}`]); // offline delete
    await vaultExec("device-a", ["mv", `/vault/${MOVE_FROM}`, `/vault/${MOVE_TO}`]); // offline rename
    await crash("device-a"); // SIGKILL the (engine-stopped) container — just to force a fresh process
    await restart("device-a"); // recreate + wait healthy; boots IDLE
    await a.start(); // /sync/start → engine.start() → bootstrap → reconcileOfflineStructural

    await waitConverged(["device-a", "device-b"], { timeoutMs: 120_000 });

    // ── OFFLINE DELETE → PROPAGATES (M1b, durable NodeFsVault): the file is GONE on A (tombstoned,
    //    not materialized back) and the tombstone replicates so B removes it too. ──────────────────
    expect(await a.exists(DELETED)).toBe(false); // genuine closed-app delete propagated, not reappeared
    expect((await a.doc(DELETED)).deleted).toBe(true); // tombstoned
    expect(await b.exists(DELETED)).toBe(false); // peer applied the inbound tombstone

    // ── OFFLINE RENAME → docId continuity: both devices land on the new path with the SAME docId;
    //    the old path is gone everywhere. ─────────────────────────────────────────────────────────
    const treeA = await a.tree();
    const treeB = await b.tree();
    expect(treeA[MOVE_FROM]).toBeUndefined();
    expect(treeB[MOVE_FROM]).toBeUndefined();
    expect(treeA[MOVE_TO]).toBeDefined();
    expect(treeB[MOVE_TO]).toBeDefined();
    expect((await a.doc(MOVE_TO)).docId).toBe(docIdBefore);
    expect((await b.doc(MOVE_TO)).docId).toBe(docIdBefore);
    expect(await b.read(MOVE_TO)).toContain("# Alpha");

    // No conflict surfaced by either operation; both devices quiescent.
    expect((await a.status()).conflicts).toEqual([]);
    expect((await b.status()).conflicts).toEqual([]);
    expect((await a.status()).pendingDocs).toBe(0);
    expect((await b.status()).pendingDocs).toBe(0);
  }, 300_000);
});
