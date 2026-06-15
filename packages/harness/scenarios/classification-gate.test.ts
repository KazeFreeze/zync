/**
 * Scenario — classification gate: a prose note that GROWS past the prose cap stays on
 * its original (sticky) prose route and keeps converging.
 *
 * `classify.ts` routes a `.md` to `crdt-prose` only while it is valid UTF-8 AND
 * `<= maxProseBytes`; a note that EXCEEDS the cap classifies fresh as `binary-blob` with
 * a grow-past-cap NOTICE. But routing is STICKY: once a path has an index entry, both
 * `bootstrap()` and `ingest.onVaultWrite()` reuse `entry.type` and never re-classify
 * (`const route = entry?.type ?? classify(...).route`). So a note that was first ingested
 * as `crdt-prose` KEEPS that route after it grows past the cap — it continues to
 * live-merge and replicate over the CRDT rather than flipping to a blob mid-life.
 *
 * THE OBSERVABLE STICKY-ROUTE PROPERTY (what this asserts over real containers):
 *   A note `notes/cap.md` is created small (prose), converges to B, then GROWS past the
 *   1 MB default cap via `/fs/edit append`. It MUST:
 *     1. stay in B's `/fs/tree` (a route flip to blob would drop it from the CRDT tree,
 *        and B would never receive the grown content), and
 *     2. converge byte-identical on A and B with `pendingDocs === 0` — the grown prose
 *        still rides the CRDT.
 *
 * ── DOCUMENTED GAP: the grow-past-cap NOTICE is not surfaced anywhere observable ──────
 * `classify.ts` ATTACHES a `notice` to the over-cap classification, but every non-test
 * call site (ingest.ts, engine.ts x2) reads `.route` and DISCARDS `.notice`, and sticky
 * routing means `classify()` is never even called for the grown note. There is no inbox
 * kind for it (`InboxKind = "conflict" | "resurrected" | "supervised-import"`) and no
 * `/status` field. Measured here: after the note grows past the cap, BOTH devices'
 * conflict inboxes stay EMPTY. We therefore assert the sticky-route + convergence (both
 * observable) and pin the empty-inbox observation, noting the notice surfacing as a gap
 * for the hardening pass. (Not skipped: sticky routing + convergence is the real,
 * passing contract; the notice is simply an un-surfaced field, not a broken behaviour.)
 *
 * The default cap is 1 MB (the daemon's `DEFAULT_MAX_PROSE_BYTES`; the harness compose
 * sets no `ZYNC_MAX_PROSE_BYTES`), so we append ~1.1 MB to cross it honestly.
 *
 * ── SETTLE-BEFORE-FLUSH (sidesteps a SEPARATE, real append-vs-flush revert race) ──────
 * Driving `/sync/flush` IMMEDIATELY after an external append — before the vault watcher
 * has ingested it into the attached CRDT doc — deterministically REVERTS the on-disk
 * edit: `engine.waitConverged()` runs `materializeLiveDiskContent`, which sees the disk
 * ahead of the (not-yet-ingested) doc and writes the STALE doc text back, clobbering the
 * append. Measured on this branch even for a 200-byte under-cap append. This is an engine
 * ordering bug, reported separately as a CRITICAL finding for the hardening pass; it is
 * ORTHOGONAL to classification. To test the sticky-route subject without tripping it, we
 * wait until A's CRDT doc has INGESTED the grown content (its `/doc` text length matches
 * disk) before driving convergence — a legitimate "let the external write settle" wait,
 * not a workaround that hides the route behaviour.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { device, resetStack, sleep, waitConverged } from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const NOTE = "notes/cap.md";
const PROSE_CAP_BYTES = 1_000_000; // daemon DEFAULT_MAX_PROSE_BYTES (compose sets no override)
const APPEND_BYTES = 1_100_000; // > cap, so the grown note crosses the prose ceiling

/**
 * Poll (WITHOUT flushing) until A's attached CRDT doc has ingested the grown disk content
 * — its `/doc` text length matches the on-disk size and is past the cap. This is the
 * settle-before-flush wait the header explains (avoids the append-vs-flush revert race).
 * Bounded; throws on timeout so it never hangs.
 */
async function waitDocIngestedPastCap(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const docLen = (await a.doc(NOTE)).text.length;
    const diskSize = (await a.tree())[NOTE]?.size ?? 0;
    if (docLen > PROSE_CAP_BYTES && docLen === diskSize) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitDocIngestedPastCap timed out after ${String(timeoutMs)}ms (docLen=${String(docLen)}, diskSize=${String(diskSize)})`,
      );
    }
    await sleep(500);
  }
}

beforeAll(async () => {
  await resetStack();
  await a.start();
  await b.start();
  await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });
}, 180_000);

afterAll(async () => {
  // No partition lever; nothing to heal.
});

test("a prose note that grows past the cap keeps its sticky prose route and converges", async () => {
  // 1. Create the note SMALL (prose) and converge — this is what binds the index entry to
  //    the crdt-prose route.
  await a.write(NOTE, "# Cap\n\nA prose note that starts well under the cap.\n");
  await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });
  expect((await b.tree())[NOTE]).toBeDefined();

  // 2. Grow it PAST the 1 MB cap via append (external-writer edit). A blob would flip
  //    route on a fresh classify, but the sticky index entry keeps it crdt-prose.
  await a.edit({ path: NOTE, append: "Z".repeat(APPEND_BYTES) });

  // Let A's CRDT doc ingest the grown content before driving convergence (see header:
  // a flush during the un-ingested window would revert the append — a separate engine bug).
  await waitDocIngestedPastCap(60_000);

  // 3. It converges byte-identical on A and B with no pending work — the grown prose
  //    still rode the CRDT (sticky route held; it did NOT become a blob).
  await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

  const treeA = await a.tree();
  const treeB = await b.tree();
  const grownA = treeA[NOTE];
  const grownB = treeB[NOTE];
  expect(grownA).toBeDefined();
  expect(grownB).toBeDefined();
  if (grownA === undefined || grownB === undefined) return;

  // Past the cap (so it genuinely crossed the prose ceiling) and identical on both.
  expect(grownA.size).toBeGreaterThan(PROSE_CAP_BYTES);
  expect(grownA.sha256).toBe(grownB.sha256);

  // Still in B's CRDT tree (a route flip to blob would have dropped it) and contents match.
  const grownText = await b.read(NOTE);
  expect(grownText.startsWith("# Cap")).toBe(true);
  expect(grownText.length).toBeGreaterThan(PROSE_CAP_BYTES);

  // DOCUMENTED GAP: no grow-past-cap notice is surfaced — both inboxes stay empty.
  expect((await a.status()).conflicts).toEqual([]);
  expect((await b.status()).conflicts).toEqual([]);
});
