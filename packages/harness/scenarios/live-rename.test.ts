/**
 * Scenario — M3 live external-mv re-key over the real relay (the RUNTIME twin of M1b).
 *
 * While the daemon is RUNNING (watcher live), a raw external `mv` inside the vault arrives at the
 * recursive `fs.watch` as delete(old) + modify(new) — there is NO native rename event on disk.
 * Pre-M3 this tombstoned + PROPAGATED the delete and ingested `new` as a FRESH docId (continuity
 * lost — the peer got a brand-new doc at the new path and the old doc was deleted everywhere). M3's
 * live coalescer buffers the delete, correlates it with the content-matched modify inside the
 * debounce window through the SAME `matchRenames` core as the closed-app bootstrap, and re-keys the
 * index in place — so the move replicates as a rename, not a delete+recreate.
 *
 * This is the harness gate for M3. The in-process suite + fuzzer prove convergence but operate on
 * the engine API, NOT on raw watcher events, so they cannot drive the running watcher's live
 * delete+modify pair. Only here do the REAL recursive fs.watch + real relay actually exercise the
 * coalescer (every prior piece of this arc had a real-relay bug that ONLY surfaced in the harness).
 *
 * THE LOAD-BEARING ASSERTION is docId CONTINUITY on the PEER. A pre-M3 (or a broken) coalescer
 * would still leave the tree shaped correctly — old path gone, new path present — because the
 * delete propagates and `new` re-materializes as a fresh doc. Same-paths is NOT enough. Only the
 * SAME docId at the new path on the peer distinguishes a live re-key from a tombstone+recreate.
 * (The revert experiment that gates this test flips precisely that docId: with the coalescer
 * disabled, `notes/alpha-live-renamed.md` arrives on device-b under a freshly-minted docId.)
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  Device,
  device,
  heal,
  resetStack,
  seedAndStart,
  sleep,
  vaultExec,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const MOVE_FROM = "notes/alpha.md";
const MOVE_TO = "notes/alpha-live-renamed.md";

/**
 * Poll a device's `/doc` (engine INDEX) until `path` is a LIVE entry carrying `expectedDocId` —
 * i.e. the RUNNING watcher saw the raw mv's delete+modify pair AND the coalescer re-keyed the index
 * in place (continuity), rather than dropping the events or tombstone+recreating under a new docId.
 *
 * We poll `/doc` (which reads `engine.index`), NOT `/fs/tree` (a raw `vault.list()` disk walk): the
 * `mv` lands on disk ATOMICALLY and instantly, so a tree poll would pass immediately regardless of
 * whether the watcher ever fired — proving nothing. A live index re-key is the only state that
 * requires the watcher + coalescer to have run. Bounded; throws on timeout so a watcher that
 * silently dropped the events fails LOUDLY here rather than passing convergence for the wrong reason.
 */
async function waitForLiveReKey(
  dev: Device,
  path: string,
  expectedDocId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await dev.doc(path);
    if (info.live && info.docId === expectedDocId) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForLiveReKey(${dev.name}, ${path}) timed out after ${String(timeoutMs)}ms: the running ` +
          `watcher+coalescer never re-keyed (saw docId=${String(info.docId)}, live=${String(info.live)}); ` +
          `expected a live re-key to docId=${expectedDocId}. A dropped watcher event or a ` +
          `tombstone+recreate (fresh docId) both land here.`,
      );
    }
    await sleep(500);
  }
}

describe("M3 live external-mv re-key (running watcher coalesces delete+modify over the real relay)", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("a raw mv while RUNNING re-keys with docId continuity on the peer (not delete+recreate)", async () => {
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    // docId of the to-be-moved note BEFORE (single seed → the SAME docId on both devices).
    const docIdBefore = (await a.doc(MOVE_FROM)).docId;
    if (docIdBefore === null) throw new Error(`seed note ${MOVE_FROM} has no docId before the mv`);
    expect((await b.doc(MOVE_FROM)).docId).toBe(docIdBefore);

    // ── LIVE external mv: the daemon stays RUNNING (watcher ON). A raw `mv` inside the vault is
    //    seen by the recursive fs.watch as delete(old) + modify(new) — NO native rename event. ─────
    await vaultExec("device-a", ["mv", `/vault/${MOVE_FROM}`, `/vault/${MOVE_TO}`]);

    // ── WATCHER-RELIABILITY GATE: prove the running watcher saw the pair AND the coalescer re-keyed
    //    on the ORIGINATOR before asserting convergence — else a dropped event (or a tombstone instead
    //    of a re-key) would "converge" for the WRONG reason. See waitForLiveReKey on why /doc, not tree.
    await waitForLiveReKey(a, MOVE_TO, docIdBefore, 120_000);

    await waitConverged(["device-a", "device-b"], { timeoutMs: 180_000 });

    // Old path gone, new path present — on BOTH devices' disks.
    const treeA = await a.tree();
    const treeB = await b.tree();
    expect(treeA[MOVE_FROM]).toBeUndefined();
    expect(treeB[MOVE_FROM]).toBeUndefined();
    expect(treeA[MOVE_TO]).toBeDefined();
    expect(treeB[MOVE_TO]).toBeDefined();

    // ── THE GATE: docId CONTINUITY on the PEER — device-b lands on the new path with the SAME docId
    //    it had at the old path. A tombstone+recreate would mint a FRESH docId here. ────────────────
    expect((await a.doc(MOVE_TO)).docId).toBe(docIdBefore);
    const docAfterB = await b.doc(MOVE_TO);
    expect(docAfterB.docId).toBe(docIdBefore);
    expect(docAfterB.live).toBe(true); // a LIVE doc, not a tombstoned old key masquerading
    expect(await b.read(MOVE_TO)).toContain("# Alpha"); // content intact across the live re-key

    // No conflict surfaced by the live re-key; both devices quiescent.
    expect((await a.status()).conflicts).toEqual([]);
    expect((await b.status()).conflicts).toEqual([]);
    expect((await a.status()).pendingDocs).toBe(0);
    expect((await b.status()).pendingDocs).toBe(0);
  }, 300_000);
});
