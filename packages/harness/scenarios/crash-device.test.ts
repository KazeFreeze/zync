/**
 * Scenario — CRASH-SAFETY: device SIGKILL with a dirty (un-acked) edit (NEW-5).
 *
 * ✅ RESOLVED by the crash-window no-loss fix (commit 626f55d, working-vs-acked base) — this is
 *    now an ACTIVE live gate and passes (the edit survives the SIGKILL and reaches the peer).
 *    The banner below is forensic history of the original data-loss bug; no longer `describe.skip`.
 *
 * ┌─ SKIPPED: reproduces a DATA-LOSS-grade crash-window dirty-drop + append-revert ───────────┐
 * │  (Task 9 / GPT#1 "crash-window dirty-drop" + Task 9 / Finding D "append-vs-flush revert")  │
 * │                                                                                            │
 * │ THE BUG (reproduced 2x against real containers, clean stack each time): a LOCAL edit that   │
 * │   is on a device's DURABLE disk + ingested into the engine's dirty-set, but whose push has  │
 * │   NOT yet acked when the device is SIGKILLed, is SILENTLY LOST after restart — AND the      │
 * │   device's own on-disk edit is REVERTED to the last-acked (pre-edit) content. The user's    │
 * │   edit vanishes on BOTH devices with NO conflict artifact and NO pending work.              │
 * │                                                                                            │
 * │ MECHANISM (captured from `engine-state.json` + relay logs): while A is PARTITIONED it edits │
 * │   notes/alpha.md. The watcher ingests it; the engine sets dirty=[alpha]. A is then KILLed   │
 * │   inside that un-acked window and restarted (durable named volume → the edit IS still on    │
 * │   A's disk after restart, confirmed). But across the crash window the engine's offline      │
 * │   quiescence path ADVANCES alpha's persisted synced-stamp toward the edit AND CLEARS the    │
 * │   dirty flag WITHOUT the push ever reaching the relay. On restart the engine reloads        │
 * │   `dirty:[]` and (after reconnect) concludes alpha is "already synced", so it NEVER          │
 * │   re-pushes — instead it pulls the relay's last-acked PRISTINE snapshot and materializes     │
 * │   it back over A's disk, CLOBBERING the edit. (This second half is the same append-vs-flush  │
 * │   revert class as classification-gate's header: `materializeLiveDiskContent` writing a       │
 * │   stale doc over a newer disk.)                                                              │
 * │                                                                                            │
 * │ EVIDENCE (run #2, the representative capture — run #1 identical):                            │
 * │   PRE-CRASH (A partitioned):  A disk alpha tail = "…crash window (must survive SIGKILL)."    │
 * │                               engine-state dirty = ["device-a-1781465522211-1"]   (alpha)   │
 * │   POST-RESTART (before sync):  A disk alpha tail = "…crash window…"  (durable volume kept it)│
 * │   AFTER start+heal+converge:                                                                 │
 * │     A /status → conn=connected pendingDocs=0 conflicts=[]                                    │
 * │     B /status → conn=connected pendingDocs=0 conflicts=[]                                    │
 * │     A alpha sha = 2d1185b33f8d  ("STATUS: pristine\n\nEnd of alpha.")  ← A's edit REVERTED   │
 * │     B alpha sha = 2d1185b33f8d  (pristine — never received the edit)                         │
 * │     A engine-state: dirty=[]   alpha stamp = 2d1185b33f8d…  (reverted to the pristine hash)  │
 * │   relay log for alpha doc "…522211-1": after A reconnects post-restart                       │
 * │     (New connection 19:32:10) there is NO further "changed"/"Store" — A never re-pushed;     │
 * │     the only Store (19:32:04) persisted the PRISTINE seed snapshot. The edit reached the     │
 * │     relay NEVER, and was erased from A's disk.                                               │
 * │                                                                                            │
 * │ WHY PARTITION-then-CRASH: a bare SIGKILL cannot land deterministically in the "ingested but  │
 * │   not yet relayed" window (the engine pushes within ms). Partitioning A first makes the      │
 * │   un-acked window deterministic — the edit is ingested + dirty-persisted but cannot relay.   │
 * │   (My first, contaminated probes "saw" the edit survive ONLY because A had briefly been on   │
 * │   syncnet so the edit had already pushed before the kill — i.e. there was nothing un-acked   │
 * │   to lose. The CLEAN sequence below, with the edit strictly inside the partition, loses it.) │
 * │                                                                                            │
 * │ DURABILITY PREREQ (confirmed working — the loss is NOT a storage artifact): device-a runs    │
 * │   on a NAMED volume (`device-a-vault:/vault`), NOT tmpfs, so its vault + `.obsidian/zync`    │
 * │   state store survive the kill+start (verified: the edit IS on disk post-restart; a tmpfs    │
 * │   `/vault` is re-mounted EMPTY). `resetStack`'s `down -v` removes it between scenarios.      │
 * │                                                                                            │
 * │ PER THE HARNESS CONTRACT we do NOT patch the engine; this feeds the Task-9 hardening pass.   │
 * │ Skipped (not deleted) so the contract it encodes — a dirty un-acked edit SURVIVES a SIGKILL  │
 * │ and re-pushes to the peer, with A's own content intact — flips green the moment the          │
 * │ synced-stamp-before-ack + revert hardening lands.                                            │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ RESIDUAL after the 0b-3 hardening pass (Fixes 1–5) — RE-CONFIRMED, STILL SKIPPED ───────────┐
 * │ Re-ran TWICE against the rebuilt (`--no-cache`) device image carrying ALL of Fixes 1–5,       │
 * │ including Fix 5 (`81418f0`, "gate dirty-clear/synced-advance on relay ack — no-loss crash      │
 * │ window"). The data loss PERSISTS — Fix 5 did NOT close the window over the REAL relay; the     │
 * │ dirty un-acked edit is still dropped on crash AND A's own on-disk edit is still reverted.      │
 * │                                                                                                │
 * │ EVIDENCE (2026-06-15, rebuilt image; identical across both runs; pre-crash dirty-set was       │
 * │   non-empty + edit confirmed on disk, so there WAS un-acked work to lose):                     │
 * │   AFTER restart+heal+start+converge (waitTargetConverged TIMED OUT at 150s):                   │
 * │     A /status → {conn:connected, pendingDocs:0, conflicts:[]}                                  │
 * │     B /status → {conn:connected, pendingDocs:0, conflicts:[]}                                  │
 * │     A /doc(notes/alpha.md) contentSha=2d1185b33f8d…  hasCrashEdit=FALSE  ← A's edit REVERTED   │
 * │     B /fs/read(notes/alpha.md) hasCrashEdit=FALSE  ← B never received the edit                 │
 * │     A engine-state.json dirty=[]  alpha stamp=2d1185b33f8d… (reverted to the PRISTINE hash)    │
 * │   relay log: after A reconnects post-restart there is NO further "changed"/"Store" for the     │
 * │     alpha doc — A never re-pushed; the edit reached the relay NEVER and was erased from disk.  │
 * │   This is the same synced-stamp-before-ack + materialize-revert data-loss the header records.  │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * INTENT (what this scenario asserts once the bug is fixed):
 * A (durable) & B converge. PARTITION A so its push window is deterministic. A edits a seeded
 * note; the watcher ingests it into the dirty-set but it cannot relay (offline). SIGKILL A in
 * that window, restart it (durable vault re-attaches the edit + state store), then re-start
 * sync and heal so the engine re-pushes its persisted dirty-set. The edit must NOT be lost:
 * it re-pushes, B materializes it (B `/fs/read` shows the edit), and A's content stays intact.
 *
 * LEVER NOTE: a `docker compose start` of a previously-PARTITIONED-then-KILLED container
 * resumes it STILL OFF syncnet (the partition persists across kill+start; verified). So the
 * scenario HEALS (reconnect syncnet) BEFORE `POST /sync/start` — calling `engine.start()`
 * while off syncnet blocks on the transport connect (the control call would hang).
 *
 * CONVERGENCE GATE: a targeted poll on the TARGET note ({@link waitTargetConverged}) — settles
 * on "B carries the edit AND A/B agree on the target sha", tolerating the SEPARATE, already-
 * documented stale-snapshot `pendingDocs` latch (three-way-merge / concurrent-create skips).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  containerLogs,
  crash,
  device,
  heal,
  partition,
  readContainerFile,
  resetStack,
  restart,
  seedAndStart,
  sleep,
  waitIngested,
  type Device,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

/** The note A edits in the un-acked window. Seeded by `mini`. */
const TARGET = "notes/alpha.md";
/** The marker A's crash-window edit appends — what B must end up carrying. */
const CRASH_EDIT = "Edited on A inside the crash window (must survive SIGKILL).";
/** Absolute path of the crash-survival state file inside device-a's vault volume. */
const STATE_FILE = "/vault/.obsidian/zync/engine-state.json";

/**
 * Bounded poll for the DURABILITY property on a single note: `follower` carries `marker`
 * AND `leader` and `follower` agree on `path`'s sha. Drives `/sync/flush` on both each round
 * (the engine catch-up lever) but settles on the TARGET — tolerating the orthogonal global
 * `pendingDocs` stale-snapshot latch (see header). Throws a diagnostic on timeout.
 */
async function waitTargetConverged(
  leader: Device,
  follower: Device,
  path: string,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all([
      leader.flush().catch(() => undefined),
      follower.flush().catch(() => undefined),
    ]);
    const followerText = await follower.read(path).catch(() => "");
    const leaderSha = (await leader.tree())[path]?.sha256;
    const followerSha = (await follower.tree())[path]?.sha256;
    if (followerText.includes(marker) && leaderSha !== undefined && leaderSha === followerSha) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitTargetConverged(${path}) timed out after ${String(timeoutMs)}ms: ` +
          `followerHasMarker=${String(followerText.includes(marker))} ` +
          `leaderSha=${String(leaderSha)} followerSha=${String(followerSha)}\n` +
          (await dumpCrashDeviceDiagnostics()),
      );
    }
    await sleep(1_000);
  }
}

describe("device SIGKILL with a dirty edit (LIVE GATE — crash-window dirty-drop + revert FIXED)", () => {
  beforeAll(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterAll(async () => {
    // Best-effort heal so a failed run never leaves A stranded off syncnet for the next file.
    await heal("device-a").catch(() => undefined);
  });

  test("a dirty (un-acked) edit survives a device SIGKILL and re-pushes to the peer", async () => {
    // 0) Baseline: A & B converged on the seeded content; the edit is not present anywhere.
    expect(await b.read(TARGET)).not.toContain(CRASH_EDIT);

    // 1) PARTITION A → make its push window deterministic (it cannot relay while off syncnet).
    await partition("device-a");

    // 2) A makes a LOCAL edit. It lands on disk (durable named volume) and the watcher ingests
    //    it into the engine's dirty-set, but the push cannot complete (A is partitioned).
    await a.edit({ path: TARGET, append: `\n${CRASH_EDIT}\n` });

    // Wait until A's CRDT has INGESTED the edit (the watcher fired): this is precisely the
    // "ingested but not yet acked" window the scenario targets — and it makes the dirty-set
    // assertion below meaningful (the doc is genuinely dirty + un-pushed because A is offline).
    await waitIngested(a, TARGET, CRASH_EDIT, 60_000);

    // Confirm the edit is on A's disk + the dirty-set is non-empty BEFORE we crash — there is
    // genuinely un-acked work to lose.
    expect(await a.read(TARGET)).toContain(CRASH_EDIT);
    const dirtyPreCrash = JSON.parse(await readContainerFile("device-a", STATE_FILE)) as {
      dirty: string[];
    };
    expect(dirtyPreCrash.dirty.length).toBeGreaterThan(0);

    // 3) SIGKILL A *inside* the un-acked window. No graceful shutdown; whatever is on the
    //    durable volume is all that survives.
    await crash("device-a");

    // 4) Restart A's container (durable vault re-attaches) and BLOCK until healthy. The daemon
    //    boots IDLE; the persisted state store + base records reload from the named volume.
    await restart("device-a");

    // A's content is intact on disk right after the restart (the durable volume kept it) — the
    // loss (asserted-against below) happens later, when the engine reverts it on reconnect.
    expect(await a.read(TARGET)).toContain(CRASH_EDIT);

    // 5) HEAL FIRST, then re-start sync. The restart resumed A STILL off syncnet (see header);
    //    `engine.start()` while off syncnet blocks on the transport connect, so reconnect first.
    await heal("device-a");
    await a.start();

    // 6) Converge on the TARGET. The DESIRED outcome: A re-pushes the un-acked edit and B
    //    materializes it. (On this branch this TIMES OUT — A reverts its own edit and never
    //    re-pushes; that is the documented data-loss bug. See header.)
    await waitTargetConverged(a, b, TARGET, CRASH_EDIT, 150_000);

    // ── ASSERTIONS: the edit survived and propagated ──────────────────────────
    expect(await b.read(TARGET)).toContain(CRASH_EDIT);
    expect(await a.read(TARGET)).toContain(CRASH_EDIT);
    const treeA = await a.tree();
    const treeB = await b.tree();
    expect(treeA[TARGET]?.sha256).toBe(treeB[TARGET]?.sha256);
  }, 300_000);
});

/**
 * Dump crash-device diagnostics (engine-state, target doc, device + server logs). Folded into
 * the timeout error of {@link waitTargetConverged} so a regression is self-documenting in CI
 * output, and exported so a maintainer can capture state without re-instrumenting.
 */
export async function dumpCrashDeviceDiagnostics(): Promise<string> {
  const lines: string[] = ["── crash-device diagnostics ──"];
  try {
    lines.push(`device-a status: ${JSON.stringify(await a.status())}`);
    lines.push(`device-b status: ${JSON.stringify(await b.status())}`);
    lines.push(`device-a engine-state: ${await readContainerFile("device-a", STATE_FILE)}`);
    lines.push(`device-a doc(${TARGET}): ${JSON.stringify(await a.doc(TARGET))}`);
    lines.push(`device-a logs:\n${await containerLogs("device-a", 60)}`);
    lines.push(`server logs:\n${await containerLogs("server", 40)}`);
  } catch (err) {
    lines.push(`diagnostic capture error: ${String(err)}`);
  }
  return lines.join("\n");
}
