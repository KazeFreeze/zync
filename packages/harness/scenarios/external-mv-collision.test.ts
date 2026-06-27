/**
 * Scenario — external mv-onto-occupied IN-PLACE collision recovery (over the real relay + real fs).
 *
 * Models a closed-app, out-of-band `mv incoming → occupant` where the occupant is a LIVE synced
 * file: the OS overwrites the occupant's bytes with the incoming's and removes the incoming file.
 * Seen ONLY by the next cold bootstrap (engine off → no watcher), this is the in-place clobber the
 * recovery pass must catch: WITHOUT recovery the occupant's bytes are lost forever and the incoming
 * note silently vanishes from its old path.
 *
 * The faithful gate (vs. the in-process external-mv-collision test): a real recursive `fs.watch` +
 * real relay + real FsDocStore/BaseStore, with the recovery artifact replicating cross-device. The
 * recovery must:
 *   - RESTORE the occupant's ORIGINAL content at the occupant path (NOT the incoming's bytes), and
 *   - PARK the incoming note at a DETERMINISTIC `… (conflict, …)` artifact path — the SAME path on
 *     BOTH devices (a pure function of the doc's metadata, never a local wall-clock), carrying the
 *     incoming's ORIGINAL content. Nothing is lost; both devices converge byte-for-byte.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  conflictArtifacts,
  crash,
  device,
  heal,
  resetStack,
  restart,
  seedAndStart,
  treesEqual,
  vaultExec,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

// Two distinct LIVE notes from the "mini" fixture: alpha is the OCCUPANT (its path is clobbered and
// must be restored); beta is the INCOMING (moved onto alpha's path; must survive at a conflict path).
const OCCUPANT = "notes/alpha.md";
const INCOMING = "notes/beta.md";

// Known fixture body markers (read directly from fixtures/mini/notes/{alpha,beta}.md).
const OCCUPANT_MARKER = "STATUS: pristine"; // alpha.md's signature line — its ORIGINAL content.
const INCOMING_MARKER = "Beta is the second synthetic note."; // beta.md's signature line.

describe("external mv-onto-occupied in-place collision (closed-app; restore occupant + park incoming)", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    await heal("device-a").catch(() => undefined);
  });

  test("a closed-app mv onto a live occupant restores the occupant + parks the incoming at the same artifact on both devices", async () => {
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    // The occupant's docId BEFORE the collision (single seed → same docId on both devices). The
    // recovery must keep the occupant doc continuous (its path restored, not re-minted).
    const occDocBefore = (await a.doc(OCCUPANT)).docId;
    expect(occDocBefore).not.toBeNull();
    expect((await b.doc(OCCUPANT)).docId).toBe(occDocBefore);

    // Sanity: both notes are live + distinct before the move.
    expect(await a.read(OCCUPANT)).toContain(OCCUPANT_MARKER);
    expect(await a.read(INCOMING)).toContain(INCOMING_MARKER);

    // ── "App closed" in-place collision: stop the engine (watcher off), `mv` the INCOMING file ONTO
    //    the OCCUPANT path out-of-band (OS overwrites occupant's bytes + removes incoming), then
    //    cold-restart a FRESH daemon so bootstrap re-scans the durable volume and recovers. ────────
    await a.stop(); // engine.stop() → no watcher; the move is seen only by the next bootstrap.
    await vaultExec("device-a", ["mv", `/vault/${INCOMING}`, `/vault/${OCCUPANT}`]);
    await crash("device-a"); // SIGKILL the engine-stopped container → force a fresh process.
    await restart("device-a"); // recreate + wait healthy; boots IDLE.
    await a.start(); // /sync/start → engine.start() → bootstrap → in-place collision recovery.

    await waitConverged(["device-a", "device-b"], { timeoutMs: 120_000 });

    // ── OCCUPANT RESTORED: its path holds the OCCUPANT's ORIGINAL content (NOT the incoming's bytes)
    //    on BOTH devices, with docId continuity. The clobber did NOT destroy the occupant. ──────────
    expect(await a.read(OCCUPANT)).toContain(OCCUPANT_MARKER);
    expect(await b.read(OCCUPANT)).toContain(OCCUPANT_MARKER);
    expect(await a.read(OCCUPANT)).not.toContain(INCOMING_MARKER); // not the incoming's bytes
    expect(await b.read(OCCUPANT)).not.toContain(INCOMING_MARKER);
    expect((await a.doc(OCCUPANT)).docId).toBe(occDocBefore);
    expect((await b.doc(OCCUPANT)).docId).toBe(occDocBefore);

    // ── INCOMING PARKED: exactly one `(conflict, …)` artifact, at the SAME path on BOTH devices
    //    (deterministic, device-independent), carrying the INCOMING's ORIGINAL content. ────────────
    const treeA = await a.tree();
    const treeB = await b.tree();
    expect(treesEqual(treeA, treeB)).toBe(true); // identical trees → artifact path agrees byte-for-byte

    const artifactsA = conflictArtifacts(treeA);
    const artifactsB = conflictArtifacts(treeB);
    expect(artifactsA.length).toBe(1); // exactly one recovery artifact — no spurious conflicts
    expect(artifactsB).toEqual(artifactsA); // SAME deterministic path on both devices

    const artifactPath = artifactsA[0];
    expect(artifactPath).toBeDefined();
    if (artifactPath === undefined) return;
    expect(await a.read(artifactPath)).toContain(INCOMING_MARKER); // the incoming's ORIGINAL content
    expect(await b.read(artifactPath)).toContain(INCOMING_MARKER);

    // The original INCOMING path is gone everywhere (it was moved onto the occupant).
    expect(treeA[INCOMING]).toBeUndefined();
    expect(treeB[INCOMING]).toBeUndefined();

    // Both devices quiescent; no unexpected conflicts beyond the recovery artifact.
    expect((await a.status()).pendingDocs).toBe(0);
    expect((await b.status()).pendingDocs).toBe(0);
  }, 300_000);
});
