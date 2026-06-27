/**
 * Scenario — M4 external folder rename (small-N): per-child docId continuity over the real relay.
 *
 * ┌─ describe.skip: CHARACTERIZES A VERIFIED, ROOT-CAUSED GAP (M4 validation, 2026-06-27) ─────────┐
 * │                                                                                                 │
 * │ A raw external `mv <folder>` while the daemon is RUNNING does NOT converge with per-child docId │
 * │ continuity over the real NodeFsVault watcher. VERIFIED root cause (instrumented `fs.watch`):    │
 * │   - A directory `rename()` is ONE syscall on the dir inode; the recursive watch fires per-child │
 * │     raw `rename` events, BUT NodeFsVault's stat-probe NEVER emits a per-child `delete` for the   │
 * │     moved-away children — it emits ONLY `delete <dir>` (the directory path, which has no index   │
 * │     entry → a no-op). Observed device-a emit stream for `mv notes archive`:                      │
 * │       modify archive/a.md,b,c   (new children → rename TARGETS)                                  │
 * │       delete notes              (the DIRECTORY only — no-op)                                     │
 * │       modify notes/a.md,b,c     (the still-live SOURCES, RE-MATERIALIZED by the engine's M1a)    │
 * │   - So M3's coalescer gets the TARGETS but never the SOURCE deletes → it cannot pair them →      │
 * │     every child is ingested under a FRESH docId AND the still-live source is re-materialized     │
 * │     (continuity loss + duplication).                                                             │
 * │                                                                                                  │
 * │ This is the harness-plumbing PREREQUISITE the arc design flagged (folder-rename-fidelity §3.4:   │
 * │ "teach NodeFsVault's watcher to distinguish create from modify — track a known-paths set") that  │
 * │ M3 left as "always emit modify" (`node-fs-vault.ts` ~211), compounded by the engine eagerly      │
 * │ re-materializing the disk-absent-but-still-live source before any delete is detected.            │
 * │                                                                                                  │
 * │ This ONE scenario CHARACTERIZES THE WHOLE external-dir-mv class — M4 cases (a) folder rename,    │
 * │ (e) ambiguous children, (f) mixed/nested, (b) backlink storm, (d) folder-move+concurrent-edit,   │
 * │ (g) child churn — they all drive `vaultExec mv <dir>` and hit this same root cause. (Case (c)    │
 * │ partial-offline uses per-FILE moves at bootstrap and is validated separately.)                   │
 * │                                                                                                  │
 * │ FIX (its own piece): a NodeFsVault watcher rewrite — known-paths-set diff classification that    │
 * │ reliably emits per-child `delete` for a directory move — plus handling the re-materialization     │
 * │ race. Flip this `describe.skip` → `describe` when that lands; the assertions below are the        │
 * │ contract (per-child PEER docId continuity).                                                       │
 * └─────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * INTENT (asserted once the watcher fix lands): a raw recursive `mv` of a folder, while RUNNING,
 * re-keys EVERY child with docId CONTINUITY on the PEER (not tombstone+recreate). The load-bearing
 * assertion is the SAME docId at every new path on the peer — tree-shape alone is insufficient.
 * Fixture `folder`: `notes/a.md|b.md|c.md` (unique prose) + `keep.md` (sibling control).
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

const CHILDREN = ["a.md", "b.md", "c.md"];

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

// GAP CLOSED (2026-06-28, live-folder-rename): engine-side dir-delete expansion + missing-live
// materialize barrier (spec 2026-06-27-zync-folder-rename-dir-delete-expansion-design.md). Un-skipped.
describe("M4 external folder rename (small-N): per-child docId continuity over the real relay", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "folder");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("a raw recursive folder mv re-keys every child with continuity on the peer", async () => {
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    // Capture the pre-rename docId for every child on BOTH devices.
    const before = new Map<string, string>();
    for (const c of CHILDREN) {
      const id = (await a.doc(`notes/${c}`)).docId;
      if (id === null) throw new Error(`no docId for notes/${c}`);
      before.set(c, id);
      expect((await b.doc(`notes/${c}`)).docId).toBe(id);
    }

    // ── LIVE external mv: the daemon stays RUNNING (watcher ON). A raw `mv` of the folder while
    //    running is seen by the recursive fs.watch as N delete(old)+modify(new) pairs. ────────────
    await vaultExec("device-a", ["mv", "/vault/notes", "/vault/archive"]);

    // ── WATCHER-RELIABILITY GATE: prove the running watcher saw EACH pair AND the coalescer
    //    re-keyed on the ORIGINATOR before asserting convergence — else a dropped event (or a
    //    tombstone instead of a re-key) would "converge" for the WRONG reason. ──────────────────
    for (const c of CHILDREN) {
      const id = before.get(c);
      if (id === undefined) throw new Error(`missing before-id for ${c}`);
      await waitForLiveReKey(a, `archive/${c}`, id, 120_000);
    }

    await waitConverged(["device-a", "device-b"], { timeoutMs: 180_000 });

    for (const c of CHILDREN) {
      const id = before.get(c);
      if (id === undefined) throw new Error(`missing before-id for ${c}`);

      expect((await a.tree())[`notes/${c}`]).toBeUndefined(); // old folder gone
      const dB = await b.doc(`archive/${c}`);
      expect(dB.docId).toBe(id); // PEER docId continuity (load-bearing)
      expect(dB.live).toBe(true);
    }

    expect((await a.tree())["keep.md"]).toBeDefined(); // sibling control untouched
    expect((await a.status()).conflicts).toEqual([]);
    expect((await b.status()).conflicts).toEqual([]);
    expect((await a.status()).pendingDocs).toBe(0);
    expect((await b.status()).pendingDocs).toBe(0);
  }, 300_000);
});
