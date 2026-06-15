/**
 * Scenario — rename + delete + docId continuity (over the real relay).
 *
 * ✅ RESOLVED by the rename-watcher-transaction fix (commit 32144c7) — this is now an ACTIVE
 *    live gate and passes. The banner below is forensic history of the original bug; the
 *    scenario is no longer `describe.skip`.
 *
 * ┌─ SKIPPED: surfaces a genuine engine/adapter bug over the REAL filesystem ───────────┐
 * │                                                                                       │
 * │ FINDING (NodeFsVault recursive watcher vs. engine-mediated rename):                    │
 * │   An engine-mediated `/fs/rename` (`vault.rename` → `fs.rename` + a synchronous        │
 * │   synthetic "rename" event) re-keys the index correctly — the new path goes LIVE with  │
 * │   the SAME docId, the old path is tombstoned, docId continuity holds, and the renamed   │
 * │   index entry REPLICATES to the peer (proven below: `/doc?path=renamed.md` returns the  │
 * │   continuous docId with full content on BOTH devices). BUT the renamed file is NEVER    │
 * │   MATERIALIZED ON DISK at the new path — on EITHER device, including the ORIGINATING    │
 * │   one. After the rename, `notes/renamed.md` is absent from `/vault` while its content   │
 * │   survives only in the CRDT/base/docStore (`/doc` shows textlen=275, fsm even reaches   │
 * │   active-bound after a force-attach, yet the disk file stays missing).                  │
 * │                                                                                         │
 * │ MECHANISM (best evidence): `fs.rename(alpha.md → renamed.md)` physically creates        │
 * │   `renamed.md`, then the engine re-keys the index. The REAL Node recursive `fs.watch`   │
 * │   ALSO fires for the physical move (a stat-probed "delete" for the vanished alpha.md     │
 * │   and a "modify" for the new renamed.md). This spurious post-rename watcher traffic —   │
 * │   which the in-process FakeVault NEVER emits — races the rename re-key and the net       │
 * │   effect is that the disk materialization at the new path is lost. The in-process       │
 * │   analogue (engine-structural Task 5 M3: "rename propagates to peer disk, same docId")   │
 * │   PASSES precisely because FakeVault.rename emits ONLY the synthetic rename event with   │
 * │   no follow-on watcher delete/modify. This is the over-the-real-FS divergence the        │
 * │   harness exists to surface.                                                             │
 * │                                                                                         │
 * │ EVIDENCE (reproduced 2x against real containers; `docker exec ... ls /vault/notes`):    │
 * │   BEFORE: alpha.md beta.md multi.md                                                     │
 * │   AFTER : beta.md multi.md            ← renamed.md never on disk (A and B)              │
 * │   /doc?path=notes/renamed.md → docId=device-a-…-1 (continuous), textlen=275            │
 * │                                                                                         │
 * │ PER THE HARNESS CONTRACT we do NOT patch the engine; this is a valuable surfaced bug    │
 * │ feeding the planned engine-hardening pass. Skipped (not deleted) so the contract it      │
 * │ encodes — disk materialization + docId continuity across an engine-mediated rename —     │
 * │ flips green the moment the hardening fix lands.                                          │
 * └───────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ RESIDUAL after the 0b-3 hardening pass (Fixes 1–5) — RE-CONFIRMED, STILL SKIPPED ─────┐
 * │ Re-ran against the rebuilt (`--no-cache`) device image carrying ALL of Fixes 1–5,       │
 * │ including Fix 2 (`61d49b7`, "materialize renamed file on receiver despite watcher echo").│
 * │ The bug PERSISTS — the renamed file is STILL never materialized on disk on EITHER        │
 * │ device, including the ORIGINATING device A (more severe than a receiver-only gap). The   │
 * │ index re-key + docId continuity work; only the disk write at the new path is lost.       │
 * │                                                                                          │
 * │ EVIDENCE (2026-06-15, rebuilt image, this scenario run in isolation, post-rename):       │
 * │   docker exec device-a ls /vault/notes → beta.md  multi.md     (NO renamed.md, NO alpha) │
 * │   docker exec device-b ls /vault/notes → beta.md  multi.md     (NO renamed.md)           │
 * │   A & B /doc(notes/renamed.md) → docId=device-a-…-1 (CONTINUOUS, same on both), full     │
 * │     text "# Alpha…" present in the CRDT — but the path is ABSENT from BOTH /fs/tree maps. │
 * │   So the index/CRDT carry the rename correctly; the on-disk materialization at the new   │
 * │   path is the missing piece. Fix 2 did NOT close it over the real recursive fs.watch.    │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * INTENT (what this scenario asserts once the bug is fixed):
 * A & B converge. A renames `notes/alpha.md` → `notes/renamed.md` via the ENGINE-MEDIATED
 * `/fs/rename`. After convergence B's disk reflects the rename (old path gone, new path
 * present) carrying the SAME docId — proven via `/doc?path=` on BOTH devices (no re-create,
 * no data loss). A then deletes a note; after convergence it is gone from B's tree.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { device, heal, resetStack, seedAndStart, waitConverged } from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const FROM = "notes/alpha.md";
const TO = "notes/renamed.md";
const TO_DELETE = "notes/beta.md";

describe("rename + delete + docId continuity (rename transaction — renamed file materializes on disk)", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("rename carries docId continuity to the peer; a subsequent delete propagates", async () => {
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    // Capture the docId BEFORE the rename (on both devices it is the SAME — single seed).
    const docIdBeforeA = (await a.doc(FROM)).docId;
    const docIdBeforeB = (await b.doc(FROM)).docId;
    expect(docIdBeforeA).not.toBeNull();
    expect(docIdBeforeA).toBe(docIdBeforeB);

    // A renames via the ENGINE-MEDIATED rename (docId continuity across the move).
    await a.rename(FROM, TO);
    await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

    // B's disk reflects the rename: old path gone, new path present.
    const treeB = await b.tree();
    expect(treeB[FROM]).toBeUndefined();
    expect(treeB[TO]).toBeDefined();
    expect(await b.read(TO)).toContain("# Alpha");

    // A's disk too (it renamed locally).
    const treeA = await a.tree();
    expect(treeA[FROM]).toBeUndefined();
    expect(treeA[TO]).toBeDefined();

    // docId CONTINUITY across the rename on BOTH devices — same docId as before, no re-create.
    const docAfterA = await a.doc(TO);
    const docAfterB = await b.doc(TO);
    expect(docAfterA.docId).toBe(docIdBeforeA);
    expect(docAfterB.docId).toBe(docIdBeforeA);

    // No spurious conflict surfaced by the rename.
    expect((await a.status()).conflicts).toEqual([]);
    expect((await b.status()).conflicts).toEqual([]);

    // DELETE: A deletes a note → it disappears from B's tree.
    await a.del(TO_DELETE);
    await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

    expect((await a.tree())[TO_DELETE]).toBeUndefined();
    expect((await b.tree())[TO_DELETE]).toBeUndefined();
  });
});
