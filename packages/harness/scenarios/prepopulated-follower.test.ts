/**
 * Scenario — a PRE-POPULATED device joins an existing vault (over the real relay).
 *
 * THE GAP THIS CLOSES. Every existing onboarding scenario boots followers EMPTY
 * (`seedAndStart`, and `bootstrap-doubled` says so explicitly). That is the realistic flow for a
 * brand-new device, but it is NOT what a real user does: they clone the vault with git, restore a
 * backup, or copy the folder across, and only THEN install Zync. That device already holds every
 * note before it ever reaches the relay, and nothing here covered it.
 *
 * WHY IT CAN GO WRONG. Bootstrap resolves a path's identity as
 * `existing?.docId ?? durableDocIdFor(path) ?? mintDocId()`. A device that has synced before is
 * protected by its durable `lastLivePath` history; a genuinely NEW device has neither that nor an
 * index entry. So if the shared index has not arrived yet, "I have not received it" is
 * indistinguishable from "it does not exist", and the device mints a COMPETING docId for every
 * note it already has. When the index finally lands, each path holds two documents. This is the
 * shape that previously turned ~190 real notes into duplicate "(conflict, …)" copies.
 *
 * The variable is HANDSHAKE TIMING, not pre-population itself:
 *   - test 1 (control) — index arrives before the start budget expires, so bootstrap sees the
 *     relay's entry and ADOPTS its docId. Pre-population is harmless. This documents the safe path.
 *   - test 2 (the real risk) — the device is reachable-but-silent while it starts, so the first
 *     index sync exceeds its budget and bootstrap falls back to the offline rail WHILE CONNECTED.
 *
 * `blackhole()` is used rather than `partition()` deliberately: partition refuses the connection
 * (an honest offline signal), while blackhole leaves the host reachable-but-silent so requests
 * hang — which is what a slow relay, a saturated uplink, and a just-resumed Android process all
 * actually look like.
 *
 * SCOPE — READ THIS BEFORE TRUSTING A GREEN RUN. This is a CONVERGENCE scenario, not a regression
 * gate for the deferral. It was checked against a deliberately disabled deferral guard and still
 * passed, so it does NOT detect the re-seed on its own. On a five-note fixture with byte-identical
 * content and a prompt reconnect, a re-seed heals completely: the LWW collision is absorbed by the
 * identical-content guard, the index converges on the relay's docId, and no artifact, pending doc
 * or docId mismatch survives for a test to observe. The harmful case needed hundreds of notes and
 * a much slower device.
 *
 * The deferral itself IS gated, by `engine.test.ts` "slow first index handshake", which asserts
 * directly that no competing docId is minted before the handshake resolves — that test was
 * confirmed to FAIL (minting `follower-0-0`) with the guard disabled. What this scenario adds is
 * end-to-end proof over a REAL relay that the git-clone onboarding flow converges at all, which
 * nothing covered before, and a place for the harmful variant to grow later.
 */

import { beforeAll, expect, test } from "vitest";
import {
  blackhole,
  conflictArtifacts,
  device,
  resetStack,
  sleep,
  treesEqual,
  unblackhole,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");
const c = device("device-c");

/** The `mini` fixture's note paths, used to compare doc IDENTITY across devices. */
const NOTES = [
  "notes/alpha.md",
  "notes/beta.md",
  "notes/multi.md",
  "daily/2026-06-13.md",
  "projects/x/plan.md",
];

/**
 * Longer than the engine's 10s first-index-sync budget, so the handshake provably expires and
 * bootstrap takes the degraded rail. Shorter and the test would pass for the wrong reason.
 */
const PAST_INDEX_SYNC_BUDGET_MS = 15_000;

beforeAll(async () => {
  await resetStack();
  // A alone seeds and starts. The followers below join a vault that ALREADY exists on the relay.
  await a.loadFixture("mini");
  await a.start();
  await waitConverged(["device-a"], { timeoutMs: 60_000 });
}, 180_000);

test("a pre-populated device with a fast handshake adopts the relay's docs", async () => {
  // B holds identical content BEFORE it has ever spoken to the relay — a git clone or folder copy.
  await b.loadFixture("mini");
  await b.start();

  await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

  const treeA = await a.tree();
  const treeB = await b.tree();
  expect(treesEqual(treeA, treeB)).toBe(true);
  for (const notePath of NOTES) {
    const docA = await a.doc(notePath);
    const docB = await b.doc(notePath);
    expect(docB.docId).toBe(docA.docId);
  }
  expect(conflictArtifacts(treeB)).toEqual([]);
  expect(conflictArtifacts(treeA)).toEqual([]);
}, 180_000);

test("a pre-populated device whose index handshake times out does not re-seed the vault", async () => {
  // C is pre-populated exactly like B, but is reachable-but-silent as it starts, so its first
  // index sync cannot complete within the budget and bootstrap runs on the degraded rail.
  await c.loadFixture("mini");
  await blackhole("device-c");
  await c.start();

  // Hold past the budget so the fallback provably happens rather than racing it.
  await sleep(PAST_INDEX_SYNC_BUDGET_MS);
  await unblackhole("device-c");

  await waitConverged(["device-a", "device-c"], { timeoutMs: 120_000 });

  const treeA = await a.tree();
  const treeC = await c.tree();
  expect(treesEqual(treeA, treeC)).toBe(true);

  // Doc IDENTITY, not merely identical bytes: a device that re-seeded would be serving its own
  // minted id. This converges to the relay's id either way on a fixture this small (see the SCOPE
  // note above), so treat it as a convergence check rather than as the deferral's gate.
  for (const notePath of NOTES) {
    const docA = await a.doc(notePath);
    const docC = await c.doc(notePath);
    expect(docA.docId).not.toBeNull();
    expect(docC.docId, `${notePath} must keep the relay's docId, not a locally minted one`).toBe(
      docA.docId,
    );
  }

  // A slow handshake is a connectivity artifact and must not manufacture conflicts either.
  expect(conflictArtifacts(treeC)).toEqual([]);
  expect(conflictArtifacts(treeA)).toEqual([]);

  // And it must not leave the fleet permanently busy — a re-seed shows up as pending that the
  // change-driven loop cannot drain.
  const statusA = await a.status();
  const statusC = await c.status();
  expect(statusC.pendingDocs).toBe(0);
  expect(statusA.pendingDocs).toBe(0);
}, 300_000);
