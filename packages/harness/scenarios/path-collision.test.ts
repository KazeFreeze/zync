/**
 * Scenario — M2 path-collision recovery (over the real relay + real recursive watcher).
 *
 * The in-process suite (crdt-yjs/test/path-collision.test.ts) proved the displacement
 * discriminator + the engine-mediated rename refusal guard, but the in-process transport CANNOT
 * faithfully test two things this harness gate exists for:
 *
 *   (A) CROSS-DEVICE replication of a concurrent closed-app rename collision. Two devices, while
 *       CLOSED, each rename their OWN file onto the SAME new path. Over a REAL relay the index
 *       `tree` register for the contested path is a CRDT LWW: one rename wins, and the engine on
 *       BOTH devices must converge to an identical tree in which NEITHER body is lost — the
 *       cross-device materialization the in-process bus cannot manufacture for a partition-born
 *       winner on a non-owning device.
 *
 *   (B) The REAL recursive `fs.watch` behaviour for a RUNTIME engine-mediated rename onto an
 *       OCCUPIED live path. `SyncEngine.requestRename` REFUSES the move BEFORE it happens (the
 *       target is a live different-docId path) — so NOTHING is moved, NEITHER the occupant nor the
 *       incoming is touched on disk, and one inbox notice is surfaced. This replaces the old
 *       after-the-move re-home, which lost the incoming content over the real watcher: the async
 *       source-delete fallout (delete(incoming.md)) raced the re-home and tombstoned the reused
 *       incoming docId. Refusing before the move sidesteps that race entirely.
 *
 * Both scenarios assert INVARIANTS (no content lost; devices converge identically; pendingDocs
 * === 0), NOT a specific docId or LWW winner — the winner of a concurrent collision is
 * non-deterministic (a Yjs client-id coin-flip), so pinning it would be flaky. The known fixture
 * body strings are the survival witnesses.
 *
 * NOTE on the rename mechanism (Scenario B). The PRODUCTION recursive `fs.watch` (NodeFsVault)
 * does NOT translate an EXTERNAL `mv` into an onRename: it probes the filesystem and emits
 * delete(old) + modify(new). The engine's refuse-before-move guard is reached ONLY via the
 * ENGINE-MEDIATED rename (`/fs/rename` → `SyncEngine.requestRename`) — the production analog of an
 * IN-APP (Obsidian) rename. So Scenario B drives `a.rename(…)`, the path that actually exercises
 * the guard. (An external closed-app `mv` is the M1b reconcile path, covered by
 * offline-reconcile.test.ts, and is exercised here in Scenario A.)
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  crash,
  device,
  heal,
  resetStack,
  restart,
  seedAndStart,
  treesEqual,
  vaultExec,
  waitConverged,
  type Device,
  type Tree,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

/** Concatenate the text of every file in `tree` (read via the device's control API). */
async function collectText(tree: Tree, d: Device): Promise<string> {
  const parts: string[] = [];
  for (const path of Object.keys(tree)) {
    parts.push(await d.read(path));
  }
  return parts.join("\n");
}

describe("M2 path-collision recovery over the real relay (concurrent collision + onRename guard)", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
    await heal("device-b").catch(() => undefined);
  });

  // ── Scenario A — concurrent closed-app collision → both bodies survive, no loss ────────────────
  //
  // Two converged devices each hold `notes/alpha.md` (docId L, body "STATUS: pristine") and
  // `notes/beta.md` (docId M, body "- one/- two/- three"). With BOTH engines STOPPED (closed-app),
  // device-a renames ITS alpha.md onto `notes/shared.md` while device-b renames ITS beta.md onto
  // the SAME `notes/shared.md`. Both renames are seen only by bootstrap on restart. The `tree`
  // register for `notes/shared.md` LWW-binds ONE winner docId; the loser's index binding falls back
  // to wherever it is still live (its untouched source on the NON-renaming device), so BOTH bodies
  // survive — the winner at `notes/shared.md`, the loser at its source path. NOTHING is lost and the
  // two devices converge to an IDENTICAL tree (the cross-device replication this harness gates).
  test("A concurrent closed-app rename collision keeps both bodies — converged, nothing lost", async () => {
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    // Survival witnesses — the two distinct fixture bodies (single-seed → same docIds on both).
    const ALPHA_MARKER = "STATUS: pristine"; // notes/alpha.md (docId L)
    const BETA_MARKER = "Beta is the second synthetic note"; // notes/beta.md (docId M)
    expect(await a.read("notes/alpha.md")).toContain(ALPHA_MARKER);
    expect(await a.read("notes/beta.md")).toContain(BETA_MARKER);

    // ── CLOSED-APP concurrent collision: stop BOTH engines (no watcher), then each device renames
    //    its OWN file onto the SAME new path out-of-band (an AI/terminal `mv` while the app is
    //    closed). Cold-restart fresh daemons so each bootstrap re-scans its durable volume and
    //    reconcileOfflineStructural re-keys the rename. ──────────────────────────────────────────
    await a.stop();
    await b.stop();
    await vaultExec("device-a", ["mv", "/vault/notes/alpha.md", "/vault/notes/shared.md"]);
    await vaultExec("device-b", ["mv", "/vault/notes/beta.md", "/vault/notes/shared.md"]);
    await crash("device-a");
    await crash("device-b");
    await restart("device-a");
    await restart("device-b");
    await a.start();
    await b.start();

    await waitConverged(["device-a", "device-b"], { timeoutMs: 180_000 });

    const treeA = await a.tree();
    const treeB = await b.tree();

    // The two devices agree byte-for-byte — the collision outcome replicated identically.
    expect(treesEqual(treeA, treeB)).toBe(true);

    // The contested path is LIVE on both devices and holds ONE of the two bodies (the LWW winner).
    expect(treeA["notes/shared.md"]).toBeDefined();
    expect(treeB["notes/shared.md"]).toBeDefined();
    const liveShared = await a.read("notes/shared.md");
    expect(liveShared.includes(ALPHA_MARKER) || liveShared.includes(BETA_MARKER)).toBe(true);

    // NOTHING VANISHED: BOTH original bodies survive live SOMEWHERE on BOTH devices (the winner at
    // notes/shared.md, the loser at its still-live source path or a recovered conflict artifact).
    for (const d of [a, b]) {
      const allText = await collectText(d.name === "device-a" ? treeA : treeB, d);
      expect(allText.includes(ALPHA_MARKER)).toBe(true);
      expect(allText.includes(BETA_MARKER)).toBe(true);
    }

    // Both devices quiescent — no latched pending doc on the displaced loser.
    expect((await a.status()).pendingDocs).toBe(0);
    expect((await b.status()).pendingDocs).toBe(0);
  }, 300_000);

  // ── Scenario B — runtime engine-mediated rename onto an occupied path → REFUSED (real watcher) ──
  //
  // Two converged devices hold `notes/occupant.md` (docId O) and `notes/incoming.md` (docId I), both
  // live. On device-a, while the engine is RUNNING, an ENGINE-MEDIATED rename (`/fs/rename` →
  // `SyncEngine.requestRename`, the production in-app-rename path) targets the OCCUPIED live path
  // occupant.md. The refuse-before-move guard must REFUSE: no physical move happens, so NEITHER file
  // is touched — occupant.md still holds the OCCUPANT body and incoming.md still holds the INCOMING
  // body, on BOTH devices. (This replaces the old after-the-move re-home, which lost the incoming
  // content over the real watcher: the async source-delete fallout raced the re-home and tombstoned
  // the reused incoming docId. Refusing before the move sidesteps that race.)
  test("A runtime rename onto an occupied path is REFUSED — both files intact, nothing moved", async () => {
    // Both engines running + converged. Create the two notes via the running watcher, then converge.
    const OCC_BODY = "OCCUPANT body — must survive a runtime rename onto its live path.\n";
    const INC_BODY =
      "INCOMING body — must NOT move; the rename onto the occupied path is refused.\n";
    const OCC_MARKER = "OCCUPANT body";
    const INC_MARKER = "INCOMING body";
    await a.write("notes/occupant.md", OCC_BODY);
    await a.write("notes/incoming.md", INC_BODY);
    await waitConverged(["device-a", "device-b"], { timeoutMs: 120_000 });
    expect(await b.read("notes/occupant.md")).toContain(OCC_MARKER);
    expect(await b.read("notes/incoming.md")).toContain(INC_MARKER);

    // ── RUNTIME engine-mediated rename onto the OCCUPIED live path (engine RUNNING). requestRename
    //    REFUSES before the move — nothing is moved, no watcher fallout, one inbox notice. The helper
    //    posts /fs/rename, which returns 200 { ok:true, renamed:false } (so the call does NOT throw).
    await a.rename("notes/incoming.md", "notes/occupant.md");

    await waitConverged(["device-a", "device-b"], { timeoutMs: 180_000 });

    const treeA = await a.tree();
    const treeB = await b.tree();

    // The two devices agree byte-for-byte — the refusal (a no-op move) replicated identically.
    expect(treesEqual(treeA, treeB)).toBe(true);

    // The OCCUPANT is UNTOUCHED at notes/occupant.md (the move was refused) on BOTH devices.
    expect(treeA["notes/occupant.md"]).toBeDefined();
    expect(treeB["notes/occupant.md"]).toBeDefined();
    expect(await a.read("notes/occupant.md")).toContain(OCC_MARKER);
    expect(await b.read("notes/occupant.md")).toContain(OCC_MARKER);

    // The INCOMING still EXISTS at its original path with its content on BOTH devices — nothing moved.
    expect(treeA["notes/incoming.md"]).toBeDefined();
    expect(treeB["notes/incoming.md"]).toBeDefined();
    expect(await a.read("notes/incoming.md")).toContain(INC_MARKER);
    expect(await b.read("notes/incoming.md")).toContain(INC_MARKER);

    // Both bodies survive live on BOTH devices (the refusal left both files exactly where they were).
    for (const d of [a, b]) {
      const allText = await collectText(d.name === "device-a" ? treeA : treeB, d);
      expect(allText.includes(OCC_MARKER)).toBe(true); // occupant untouched
      expect(allText.includes(INC_MARKER)).toBe(true); // incoming untouched
    }

    // Both devices quiescent — the refusal moved nothing, no wedge.
    expect((await a.status()).pendingDocs).toBe(0);
    expect((await b.status()).pendingDocs).toBe(0);
  }, 300_000);
});
