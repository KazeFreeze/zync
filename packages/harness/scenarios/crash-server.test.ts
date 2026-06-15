/**
 * Scenario — CRASH-SAFETY: relay SIGKILL + restart (Yjs snapshot recovery).
 *
 * The property under test: a hard `docker kill -s KILL` of the RELAY must not lose ACKED
 * note state. The relay debounces `onStoreDocument` (snapshot persistence) at 2s / 10s
 * maxDebounce to the durable `server-snapshots:/data` volume; on restart it reloads each
 * doc's persisted Yjs snapshot via `onLoadDocument`. So an edit that has been quiescent
 * past the debounce window — i.e. it was flushed to a `.bin` snapshot — must reappear after
 * the relay restarts, and A & B must reconverge to identical trees carrying every edit.
 *
 * DURABILITY PREREQ: the relay's `ZYNC_SNAPSHOT_DIR=/data/snapshots` lives on the NAMED
 * volume `server-snapshots:/data`, which survives the kill+start of the SAME server
 * container; `resetStack`'s `down -v` wipes it between scenarios for isolation.
 *
 * SEQUENCING for a DETERMINISTIC pass: we make the edits, then drive both devices to
 * QUIESCENCE (`waitConverged`) and additionally SLEEP past the relay's 2s debounce + a
 * margin, so the edits are guaranteed flushed to durable snapshots BEFORE we SIGKILL the
 * relay. This isolates the assertion to "acked + persisted state survives a server crash"
 * and AWAY from the unavoidable durability boundary (a sub-second edit still inside the
 * un-flushed debounce window at the instant of SIGKILL is acceptably lost — documented, not
 * asserted against). If an edit that was PAST the debounce window is lost → that is a bug;
 * the test fails and is documented + skipped referencing the finding.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  containerLogs,
  crashServer,
  device,
  resetStack,
  restartServer,
  seedAndStart,
  sleep,
  treesEqual,
  waitConverged,
  waitIngested,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

/** Notes seeded by `mini` that we edit before crashing the relay. */
const EDITS: { path: string; marker: string }[] = [
  { path: "notes/alpha.md", marker: "alpha edit before relay SIGKILL" },
  { path: "notes/beta.md", marker: "beta edit before relay SIGKILL" },
  { path: "notes/multi.md", marker: "multi edit before relay SIGKILL" },
];

/** Relay snapshot debounce is 2s; sleep past it (+ margin) so edits are flushed to disk. */
const DEBOUNCE_FLUSH_MS = 4_000;

beforeAll(async () => {
  await resetStack();
  await seedAndStart("device-a", ["device-b"], "mini");
}, 180_000);

afterAll(async () => {
  // Best-effort: if a run died mid-crash, make sure the relay is back so the next file boots.
  await restartServer().catch(() => undefined);
});

test("acked note state survives a relay SIGKILL via persisted Yjs snapshots", async () => {
  // 1) A makes several edits across distinct notes; B materializes them over the relay.
  //    SETTLE-BEFORE-FLUSH: after each external append, wait until A's CRDT has INGESTED the
  //    disk edit BEFORE driving convergence (whose flush would otherwise revert the append —
  //    the documented append-vs-flush race; see waitIngested + classification-gate.test.ts).
  for (const { path, marker } of EDITS) {
    await a.edit({ path, append: `\n${marker}\n` });
    await waitIngested(a, path, marker, 60_000);
  }
  await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

  // Capture the converged tree — this is the state that MUST survive the relay crash.
  const treeBeforeCrash = await a.tree();
  expect(treesEqual(treeBeforeCrash, await b.tree())).toBe(true);
  for (const { path, marker } of EDITS) {
    expect(await b.read(path)).toContain(marker);
  }

  // 2) Wait past the relay's debounce window so the converged state is flushed to durable
  //    `.bin` snapshots BEFORE the SIGKILL (isolates the test to acked+persisted recovery).
  await sleep(DEBOUNCE_FLUSH_MS);

  // 3) SIGKILL the relay (no graceful shutdown / no final flush).
  await crashServer();

  // 4) Restart the relay and BLOCK until healthy. On boot it reloads each doc's snapshot via
  //    onLoadDocument from the durable volume.
  await restartServer();

  // 5) Reconverge: devices reconnect to the fresh relay; the relay serves the reloaded
  //    snapshots; A & B reconverge to identical trees with every edit intact.
  await waitConverged(["device-a", "device-b"], { timeoutMs: 120_000 });

  // ── ASSERTIONS: no ACKED data lost across the relay crash ──────────────────
  const treeA = await a.tree();
  const treeB = await b.tree();
  expect(treesEqual(treeA, treeB)).toBe(true);
  // The reconverged tree is byte-identical (sha-map) to the pre-crash converged tree:
  // every acked edit reloaded from the persisted snapshot, nothing reverted/lost.
  expect(treesEqual(treeA, treeBeforeCrash)).toBe(true);

  for (const { path, marker } of EDITS) {
    expect(await a.read(path)).toContain(marker);
    expect(await b.read(path)).toContain(marker);
  }
}, 240_000);

// If a PAST-debounce edit is lost after the relay restart, the snapshot-recovery path has a
// bug: capture diagnostics, convert to `describe.skip` with a header referencing the finding,
// and paste the dump into the report.
export async function dumpCrashServerDiagnostics(): Promise<string> {
  const lines: string[] = ["── crash-server diagnostics ──"];
  try {
    lines.push(`device-a tree: ${JSON.stringify(await a.tree())}`);
    lines.push(`device-b tree: ${JSON.stringify(await b.tree())}`);
    lines.push(`device-a status: ${JSON.stringify(await a.status())}`);
    lines.push(`server logs:\n${await containerLogs("server", 60)}`);
  } catch (err) {
    lines.push(`diagnostic capture error: ${String(err)}`);
  }
  return lines.join("\n");
}
