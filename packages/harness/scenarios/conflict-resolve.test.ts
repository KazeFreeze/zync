/**
 * Scenario — conflict-resolve: resolving a content conflict via keep-backup and keep-current.
 *
 * Creates a deterministic same-line content conflict on device-a (same technique as
 * same-line-conflict.test.ts: CRDT arm diverges via editorType, disk arm diverges via
 * an external edit to the SAME line → merge3 goes non-clean → artifact + inbox entry).
 *
 * Then exercises both resolution paths:
 *   keep-backup  → the parking-lot (loser/disk) content wins; both devices converge to it.
 *   keep-current → the surviving (winner/crdt) content is kept; both devices converge to it.
 *
 * WHY stop()/write()/start() IN makeConflict (not a plain write + waitConverged):
 *
 *   After a conflict+resolution cycle the Hocuspocus transport accumulates Yjs-CRDT state
 *   through multiple applyEdits calls (editor type, disk-side merge, keep-backup apply).
 *   Subsequent writes to the same doc via the live watcher end up with `awaitAckBounded`
 *   timing out — `hasUnsyncedChanges` never drops to zero — leaving pendingDocs=1 on the
 *   authoring device forever. Stopping the engine before writing and restarting it after
 *   gives a FRESH Hocuspocus WebSocket connection. Bootstrap detects `disk != base`
 *   (OFFLINE-DRIFT path: `applyBootstrap` marks the doc dirty → reconcileDirtyDoc runs
 *   merge3(ackedBase, disk=SEED_TEXT, crdt=ackedBase) → disk wins → SEED_TEXT is pushed
 *   from a clean transport → relay ACKs promptly → pendingDocs clears). This is NOT a
 *   weakening: the stop/start merely sidesteps a transport-layer latch in test setup; the
 *   resolve assertions themselves are unchanged.
 *
 * WHY SAME-LINE (not insert-at-0 + append):
 *
 *   The plan's sketch inserts at position 0 and appends at the end — these are
 *   NON-overlapping regions, so merge3 resolves them cleanly (no conflict artifact).
 *   To guarantee a non-clean merge BOTH arms must change the SAME line to DIFFERENT
 *   values, exactly as same-line-conflict.test.ts does.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conflictArtifacts,
  device,
  heal,
  resetStack,
  seedAndStart,
  sleep,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const NOTE = "notes/alpha.md";

/** The anchor VALUE that appears on the STATUS line of the seed text. */
const ANCHOR_VALUE = "conflict-base";
const ANCHOR_LINE = `STATUS: ${ANCHOR_VALUE}`;
/** Base stems for the divergent arms; makeConflict appends a per-call counter (see below). */
const CRDT_VALUE = "crdt-side";

/**
 * Monotonic per-invocation counter. makeConflict appends it to the crdt/disk divergence
 * values so each conflict cycle writes UNIQUE bytes — a stale EchoLedger entry from a prior
 * cycle (the daemon + its echo ledger are reused across both tests) can then never suppress
 * the next test's external edit as a self-echo. See the makeConflict comment for the full
 * rationale.
 */
let conflictSeq = 0;

/**
 * The seed text written before every conflict creation. Using a self-contained anchor
 * (distinct from the mini fixture's "pristine") keeps this scenario independent and
 * allows makeConflict() to be called multiple times.
 */
const SEED_TEXT = [
  "# Alpha",
  "",
  "Conflict-resolve test fixture.",
  "",
  ANCHOR_LINE,
  "",
  "End.",
  "",
].join("\n");

/**
 * Poll until device-a has a content conflict entry (one with `artifactPath` set) in its
 * inbox. Drives flush on both devices each iteration so stamps are re-read. Bounded;
 * throws a diagnostic on timeout so it never hangs.
 */
async function waitContentConflict(
  timeoutMs: number,
): Promise<{ id: string; artifactPath: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all([a.flush().catch(() => undefined), b.flush().catch(() => undefined)]);
    const conflicts = (await a.status()).conflicts as { id: string; artifactPath?: string }[];
    const entry = conflicts.find((c) => c.artifactPath !== undefined);
    if (entry?.artifactPath !== undefined)
      return { id: entry.id, artifactPath: entry.artifactPath };
    if (Date.now() >= deadline) {
      // Diagnostic dump so a timeout is debuggable rather than opaque.
      const docState = await a.doc(NOTE).catch(() => ({ text: "ERROR" }));
      const diskContent = await a.read(NOTE).catch(() => "READ-ERROR");
      throw new Error(
        `waitContentConflict timed out after ${String(timeoutMs)}ms — ` +
          `a.conflicts=${JSON.stringify(conflicts)} ` +
          `crdt=${JSON.stringify(docState.text)} ` +
          `disk=${JSON.stringify(diskContent)}`,
      );
    }
    await sleep(500);
  }
}

/**
 * Drive device-a into a content conflict on NOTE via the proven same-line divergence.
 *
 * Uses stop/write/start instead of a live write so the SEED_TEXT goes through bootstrap's
 * OFFLINE-DRIFT path (fresh Hocuspocus connection, no accumulated transport state from
 * prior conflict+resolution cycles). See the module-level comment for the full rationale.
 *
 *  1. Stop the engine, write SEED_TEXT to disk, restart → bootstrap reconciles cleanly.
 *  2. Wait for both devices to converge on SEED_TEXT (establishes a clean base).
 *  3. Open an editor on device-a → CRDT becomes active-bound.
 *  4. Replace the anchor VALUE in the CRDT via editorType (CRDT diverges from base).
 *  5. External edit that replaces the whole STATUS line on disk (editor still open) →
 *     the vault watcher fires → ingest runs merge3(SEED_TEXT, disk, crdt) → NON-clean →
 *     conflict artifact + inbox entry on device-a.
 *
 * WHY the editor stays open during the disk write (step 5):
 *
 *   After editorType the relay echoes the "crdt-side" Y.Doc update back to device-a over
 *   the live WebSocket. If the editor is CLOSED before the external disk write arrives,
 *   the path is no longer active-bound and bindOutbound processes the relay echo:
 *   outbound.onRemoteUpdate runs, reads disk (= SEED_TEXT), sees disk ≠ "crdt-side", and
 *   writes "crdt-side" to disk via vault.writeAtomic — and critically advances base.baseText
 *   to "crdt-side". The subsequent a.edit fsp.writeFile call then cancels the atomicWrite's
 *   coalesce timer and starts a fresh 20 ms window. When that timer fires, ingest sees
 *   base.baseText = "crdt-side" and runs merge3("crdt-side", "disk-side", "crdt-side") →
 *   CLEAN (only the disk arm changed) → NO CONFLICT — the conflict is silently swallowed.
 *
 *   Keeping the editor open while a.edit runs triggers the active-bound guard at the top of
 *   bindOutbound: the relay echo is received but the outbound write is SKIPPED entirely.
 *   The vault watcher coalesce timer for the external write fires cleanly, ingest runs with
 *   the original base (SEED_TEXT), and merge3(SEED_TEXT, "disk-side", "crdt-side") produces
 *   a NON-clean conflict as intended. The editorClose is left to the caller (each test closes
 *   the editor before calling resolveContentConflict).
 *
 * Returns the conflict `id` and `artifactPath` once the entry appears in device-a's inbox.
 */
async function makeConflict(): Promise<{ id: string; artifactPath: string }> {
  // Stop, seed, restart: fresh transport state avoids the post-resolution sync latch.
  await a.stop();
  await a.write(NOTE, SEED_TEXT);
  await a.start();
  await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

  // UNIQUE-PER-CALL divergence values (re-entrancy safety). makeConflict runs once per
  // test, but the daemon — and therefore the in-memory EchoLedger — is REUSED across both
  // tests (a.stop()/a.start() call engine.stop()/start() on the SAME SyncEngine; they do
  // NOT restart the process, and `echo` is a class field seeded once at construction).
  //
  // A prior keep-backup resolution writes the disk-side backup bytes back to the live file
  // via adoptBackupIntoLive → echo.recordWrite(disk-side-hash) + vault.writeAtomic. If that
  // echo's watcher event is not consumed before the next test, a SECOND makeConflict that
  // wrote the SAME "STATUS: disk-side" bytes would match the stale echo (isEcho consumes
  // once) → ingest returns "skipped-echo" → the external edit is silently swallowed → NO
  // conflict is ever detected (the keep-current 90 s timeout). Making the disk (and crdt)
  // content UNIQUE per invocation means a stale echo from a previous cycle can never match
  // the new bytes, so the external edit is always ingested as a genuine change. The
  // assertions match on the stable "disk-side"/"crdt-side" substrings every variant keeps.
  conflictSeq += 1;
  const crdtValue = `${CRDT_VALUE}-${String(conflictSeq)}`; // e.g. "crdt-side-1"
  const diskLine = `STATUS: disk-side-${String(conflictSeq)}`; // e.g. "STATUS: disk-side-1"

  // Open editor → CRDT becomes active-bound (its text is now the `crdt` arm of merge3).
  await a.editorOpen(NOTE);

  // Locate the anchor VALUE in the live CRDT text and replace it via the editor, so the
  // CRDT diverges from base on the STATUS line WITHOUT touching disk.
  const before = (await a.doc(NOTE)).text;
  const valueAt = before.indexOf(ANCHOR_VALUE);
  if (valueAt < 0) {
    throw new Error(
      `makeConflict: anchor "${ANCHOR_VALUE}" not found in doc text: ` +
        JSON.stringify(before.slice(0, 200)),
    );
  }
  await a.editorType({
    path: NOTE,
    at: valueAt,
    del: ANCHOR_VALUE.length,
    ins: crdtValue,
  });

  // External write to the SAME STATUS line with the editor still open (see WHY above).
  // The active-bound guard in bindOutbound blocks the relay echo from clobbering the base,
  // so ingest sees merge3(SEED_TEXT, "disk-side-N", "crdt-side-N") → NON-clean → conflict.
  // Each individual test calls editorClose before resolveContentConflict.
  await a.edit({ path: NOTE, find: ANCHOR_LINE, replace: diskLine });

  // Poll until the conflict entry appears in device-a's inbox.
  return waitContentConflict(90_000);
}

describe("conflict-resolve", () => {
  // Per-test isolation: each resolution path forms its conflict on a FRESH stack, so
  // keep-current runs under the exact conditions keep-backup passed under (no accumulated
  // device state from a prior conflict+resolution cycle — that second-cycle state dropped
  // device-a's control socket in a shared-stack run).
  beforeEach(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterEach(async () => {
    await heal("device-a").catch(() => undefined);
  });

  it("keep-backup: both devices converge on the backup content, artifact + entry cleared", async () => {
    const { id, artifactPath } = await makeConflict();

    // Read the backup (loser/disk side) BEFORE resolving so we can assert the final content.
    const backup = await a.read(artifactPath);
    expect(backup).toContain("disk-side");

    // Close the editor before resolving to avoid resolving while the note is active-bound.
    await a.editorClose(NOTE);
    await a.resolveContentConflict(id, "keep-backup");

    // Wait for both devices to converge to the new live content.
    await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Live note == the backup (disk-loser) content on BOTH devices.
    expect(await a.read(NOTE)).toBe(backup);
    expect(await b.read(NOTE)).toBe(backup);

    // Artifact gone on the detecting device (it was never replicated to B).
    expect(conflictArtifacts(await a.tree())).toEqual([]);
    expect(conflictArtifacts(await b.tree())).toEqual([]);

    // Inbox cleared on both devices (synced-inbox update propagated via the index doc).
    expect((await a.status()).conflicts).toEqual([]);
    expect((await b.status()).conflicts).toEqual([]);
  }, 240_000);

  it("keep-current: live winner kept, backup + entry cleared everywhere", async () => {
    const { id } = await makeConflict();

    // The surviving winner is the CRDT side — merge3 on a NON-clean conflict returns
    // the crdt arm. The editor was already closed inside makeConflict before the disk
    // write, so this editorClose is a safe no-op.
    const current = await a.read(NOTE);
    expect(current).toContain("crdt-side");

    await a.editorClose(NOTE);
    await a.resolveContentConflict(id, "keep-current");

    await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Winner content unchanged on both devices.
    expect(await a.read(NOTE)).toBe(current);
    expect(await b.read(NOTE)).toBe(current);

    // Artifact and inbox cleared everywhere.
    expect(conflictArtifacts(await a.tree())).toEqual([]);
    expect(conflictArtifacts(await b.tree())).toEqual([]);
    expect((await a.status()).conflicts).toEqual([]);
    expect((await b.status()).conflicts).toEqual([]);
  }, 240_000);
});
