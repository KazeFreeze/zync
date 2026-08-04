/**
 * Scenario — OFFLINE RESTART: the index survives a restart with the relay unreachable.
 *
 * This is the gate that would have caught the v0.9.1 wedge automatically. That bug made Zync
 * unusable offline on mobile for weeks — `start()` never completed while the server was
 * unreachable, so every index-gated surface sat on "Loading plugin sync settings" forever and
 * restarting only restarted the wait. EVERY automated gate passed the entire time, because index
 * persistence and offline restart had ZERO integration coverage: the harness's
 * `FsEngineStateStore` did not implement the (optional) snapshot methods, and `daemon.ts` never
 * passed `indexIdentity`, so harness engines ran with persistence fully disabled.
 *
 * Two properties, both required:
 *
 *  1. `start()` COMPLETES while the relay is unreachable. Bounded explicitly below — a wedged
 *     start would otherwise just hang until the suite timeout with no diagnosis.
 *  2. The index comes back with REAL state, not an empty one — i.e. it hydrated from the local
 *     snapshot rather than being rebuilt from whatever happens to be on disk.
 *
 * ── Why {@link blackhole} and not {@link partition} ─────────────────────────────────────────
 * `partition()` removes the device from syncnet, so `server` stops RESOLVING and requests fail
 * IMMEDIATELY. The v0.9.1 wedge does not reproduce under that shape: it needs a host that is
 * genuinely UNREACHABLE, where the request never settles at all (what an unreachable relay does
 * to `fetch()` on Android). `blackhole()` swaps the device onto a network where the `server`
 * alias is held by a container that accepts TCP and then answers nothing, so connections hang.
 * A version of this scenario built on `partition()` would pass while the real failure mode went
 * untested.
 *
 * ── Why the blob ───────────────────────────────────────────────────────────────────────────
 * The wedge was in `bootstrap()`, which awaits `onLocalBlobWrite` for every on-disk blob →
 * `blobStore.has()` → `fetch()`. With no blob in the vault that code path never runs and the
 * scenario would assert nothing about it. {@link BIN} is written LIVE (blobs present at
 * bootstrap are never published) so it is on device-a's disk for the offline restart.
 *
 * ── Why device-a ───────────────────────────────────────────────────────────────────────────
 * Its `/vault` is a NAMED VOLUME, so the vault AND `.obsidian/zync` (engine state, docstore,
 * index snapshot) survive kill + start. device-b/c are tmpfs and would come back empty, which
 * would "lose" the snapshot for the wrong reason.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  blackhole,
  crash,
  device,
  restart,
  resetStack,
  unblackhole,
  waitBlobsSettled,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const KEEP = "notes/keep.md";
const GONE = "notes/gone.md";
const BIN = "assets/attach.bin";

/** Not valid UTF-8 ⇒ classified `binary-blob`, so it rides the blob endpoint. */
const BIN_BYTES = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 128, 129, 130]);

/** Bound on the offline `start()`. Generous vs. the 15s blob-request timeout, but FINITE. */
const OFFLINE_START_BUDGET_MS = 120_000;

beforeAll(async () => {
  await resetStack();
  await a.start();
  await b.start();
}, 180_000);

afterAll(async () => {
  // Best-effort: never leave device-a stranded on the blackhole network for the next scenario.
  await unblackhole("device-a").catch(() => undefined);
});

test("an offline restart hydrates the index from its local snapshot", async () => {
  // ── converge some real state onto device-a ────────────────────────────────────────────────
  await a.write(KEEP, "keep me\n");
  await a.write(GONE, "delete me\n");
  await a.write(BIN, BIN_BYTES);
  await waitConverged(["device-a", "device-b"], { timeoutMs: 180_000 });
  await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 180_000 });

  // B deletes a note. Once A converges, A has NO file at GONE but its index holds a TOMBSTONE —
  // state that a from-disk rebuild cannot invent, which is what makes it a hydration proof.
  await b.del(GONE);
  await waitConverged(["device-a", "device-b"], { timeoutMs: 180_000 });
  expect(await a.exists(GONE)).toBe(false);

  const keepDocIdBefore = (await a.doc(KEEP)).docId;
  expect(keepDocIdBefore).not.toBeNull();

  // ── close the app, lose the network, reopen ───────────────────────────────────────────────
  // Stop the ENGINE first: `stop()` clears the persist timers and AWAITS a final save, so the
  // snapshot on disk is deterministic. Without it this raced the 2s debounce / 20s max-wait and
  // the SIGKILL landed mid-window, leaving a 2-byte (empty) snapshot on disk — the crash-during-
  // first-sync durability gap, which is its OWN scenario (see the deferred list) and must not be
  // conflated with the offline-restart property under test here.
  await a.stop();
  // ...then kill the PROCESS anyway, so nothing still in RAM can carry the index across.
  await crash("device-a");
  await restart("device-a"); // daemon comes back IDLE — the engine is not started yet
  await blackhole("device-a"); // applied AFTER restart: `compose up` would re-attach syncnet

  const started = await Promise.race([
    a.start().then(() => "started" as const),
    new Promise<"wedged">((r) => {
      setTimeout(() => {
        r("wedged");
      }, OFFLINE_START_BUDGET_MS);
    }),
  ]);
  // PROPERTY 1. A hang here is the v0.9.1 regression itself, not a flake.
  expect(started).toBe("started");

  // Sanity: it really is offline. If this ever reads "connected" the blackhole lever is broken
  // and every assertion below would be testing the ONLINE path by accident.
  expect((await a.status()).conn).not.toBe("connected");

  // ── PROPERTY 2: real index state, restored from disk ──────────────────────────────────────
  // With the relay unreachable `indexSyncedOnce` cannot be set, so `hydrated` is true ONLY via
  // the persisted snapshot.
  expect((await a.status()).hydrated).toBe(true);

  // The live note is still a live index entry under the SAME docId (no re-mint).
  const keepAfter = await a.doc(KEEP);
  expect(keepAfter.live).toBe(true);
  expect(keepAfter.docId).toBe(keepDocIdBefore);

  // The tombstone survived. Its path has no file on disk, so an index rebuilt from disk would
  // have no entry at all and `/doc` would 404 — this is the assertion that a weaker scenario
  // (one that only checks files it can also read off the disk) would silently pass without.
  const goneAfter = await a.doc(GONE);
  expect(goneAfter.deleted).toBe(true);
  expect(goneAfter.live).toBe(false);
}, 600_000);
