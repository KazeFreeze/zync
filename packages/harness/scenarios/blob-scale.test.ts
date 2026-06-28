/**
 * Scenario — blob-scale: PROVE the blob-fetch decouple over the real relay + MinIO.
 *
 * THE gate for the blob-fetch-orchestration build (P1 Task 11). It proves three properties at
 * a realistic scale (~150 binary blobs, ~50 MB) over real containers, with the server's blob GET
 * latch armed (ZYNC_BLOB_GET_DELAY_MS=200 — see docker-compose.yml + file-endpoint.ts):
 *
 *   1. DECOUPLE      — PROSE converges on the follower (B) while the blob queue is STILL draining
 *                      (`blobs.settled === false` AND `materialized < total` at the prose-converged
 *                      instant). Background blob materialization never gates prose convergence.
 *   2. BYTE-CORRECT  — every `.bin` materializes on B with a sha IDENTICAL to A's (content-addressed
 *                      → identical bytes) and zero blob failures.
 *   3. CAP HELD      — the server's observed concurrent-GET peak (`/_blob-stats`) stays within the
 *                      DEFAULT_BLOB_CONCURRENCY cap (<= 4) yet shows real concurrency (>= 2).
 *
 * WHY a wide, DETERMINISTIC decoupling window: blobs are written LIVE FIRST (so B's bounded queue is
 * backlogged), the prose (~5 tiny `.md`) is written AFTER (so it converges in seconds), and each blob
 * GET is delayed 200ms server-side. Draining N blobs costs >= N/concurrency * 200ms (~7.5s for 150 @
 * cap 4) — an order of magnitude longer than prose convergence — so the window is large and stable,
 * not a race. (If it ever flakes, raise the blob count or the GET delay — never weaken the assertion.)
 *
 * A second test pins the classify-pre-filter invariant: while a fresh blob batch is draining on B, a
 * prose rename on A converges cleanly AND no blob is ever mis-coalesced as the rename target (no
 * conflict artifact on any blob path). A heavier `@scale` variant (443 files / ~300 MB) is present but
 * gated behind `pnpm harness:scale` (ZYNC_HARNESS_SCALE=1) so it never burdens the default gate.
 *
 * FIXTURE: GENERATED at runtime by a seeded PRNG (reproducible, NOT committed); the `.bin` extension
 * routes to `binary-blob` via classify regardless of content. Blobs are written LIVE after start — a
 * bootstrap-present blob is never published (see blob-sync.test.ts header).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  blobAuthHeader,
  conflictArtifacts,
  device,
  proseTreesEqual,
  resetStack,
  SERVER_BLOB_BASE,
  sleep,
  waitBlobsSettled,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

// ── default-gate sizing ──────────────────────────────────────────────────────
const BLOB_COUNT = 150;
const BLOB_SIZE = 340 * 1024; // ~340 KB each → ~50 MB total
const PROSE_COUNT = 5;

// ── @scale opt-in sizing (pnpm harness:scale only) ───────────────────────────
const SCALE = process.env.ZYNC_HARNESS_SCALE === "1";
const SCALE_BLOB_COUNT = 443;
const SCALE_BLOB_SIZE = Math.round((300 * 1024 * 1024) / SCALE_BLOB_COUNT); // ~300 MB total

/**
 * Deterministic seeded byte generator (mulberry32-style). Distinct `seed` → distinct content, so
 * each path gets a unique sha. Reproducible across runs — the fixture is regenerated, never committed.
 */
function seededBytes(seed: number, len: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (t ^ (t >>> 14)) & 0xff;
  }
  return out;
}

/** Zero the server's concurrent-GET peak so a measurement window starts clean (unauth route). */
async function resetBlobStats(): Promise<void> {
  await fetch(`${SERVER_BLOB_BASE}/_blob-stats?reset=1`, { headers: { ...blobAuthHeader } }).catch(
    () => undefined,
  );
}

interface BlobStats {
  maxConcurrentGets: number;
  getCount: number;
}

/** Read the server's concurrent-GET peak (the cap proof). */
async function readBlobStats(): Promise<BlobStats> {
  const res = await fetch(`${SERVER_BLOB_BASE}/_blob-stats`, { headers: { ...blobAuthHeader } });
  if (!res.ok) throw new Error(`GET /_blob-stats → ${String(res.status)}`);
  return (await res.json()) as BlobStats;
}

/**
 * Write `count` seeded `.bin` blobs LIVE on `dev` under `prefix/`, with bounded write concurrency so
 * the burst lands quickly without flooding the control API. Returns the written paths (sorted order).
 */
async function writeBlobs(
  prefix: string,
  count: number,
  size: number,
  seedBase: number,
): Promise<string[]> {
  const paths = Array.from(
    { length: count },
    (_, i) => `${prefix}/blob-${String(i).padStart(4, "0")}.bin`,
  );
  const WRITE_CONCURRENCY = 10;
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      const path = paths[i];
      if (path === undefined) return;
      await a.write(path, seededBytes(seedBase + i, size));
    }
  }
  await Promise.all(Array.from({ length: WRITE_CONCURRENCY }, () => worker()));
  return paths;
}

/**
 * The full blob-scale proof (steps 1-6), parametrized so the default gate and the heavier `@scale`
 * variant are structurally identical. Returns the observed concurrent-GET peak for logging.
 */
async function runBlobScaleProof(opts: {
  prefix: string;
  blobCount: number;
  blobSize: number;
  proseCount: number;
  seedBase: number;
  decoupleTimeoutMs: number;
  settleTimeoutMs: number;
}): Promise<number> {
  // 1. Clean measurement window.
  await resetBlobStats();

  // 2. BLOBS FIRST (backlog B's queue), THEN the fast-converging prose.
  await writeBlobs(opts.prefix, opts.blobCount, opts.blobSize, opts.seedBase);
  for (let i = 0; i < opts.proseCount; i++) {
    await a.write(
      `notes/${opts.prefix}-prose-${String(i)}.md`,
      `# Prose ${String(i)}\n\nLive prose note ${String(i)} — rides the CRDT while blobs drain.\n`,
    );
  }

  // 3. DECOUPLING PROOF: poll until PROSE converges on B, then assert blobs are STILL draining.
  const deadline = Date.now() + opts.decoupleTimeoutMs;
  let bStatusAtConverge: Awaited<ReturnType<typeof b.status>> | null = null;
  for (;;) {
    await Promise.all([a.flush().catch(() => undefined), b.flush().catch(() => undefined)]);
    const [ta, tb] = await Promise.all([a.tree(), b.tree()]);
    if (proseTreesEqual(ta, tb)) {
      // Capture B's blob state at the prose-converged instant (blobs decouple from prose).
      bStatusAtConverge = await b.status();
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `prose did not converge on B within ${String(opts.decoupleTimeoutMs)}ms ` +
          `(the decoupling window could not be observed)`,
      );
    }
    await sleep(500);
  }
  // THE decoupling assertion: prose is done, blobs are NOT — and the queue knows it.
  expect(bStatusAtConverge.blobs.total).toBeGreaterThan(0);
  expect(bStatusAtConverge.blobs.settled).toBe(false);
  expect(bStatusAtConverge.blobs.materialized).toBeLessThan(bStatusAtConverge.blobs.total);
  console.log(
    `[blob-scale] decouple @ prose-converged: blobs=${JSON.stringify(bStatusAtConverge.blobs)}`,
  );

  // 4. Now let the background blob queue drain to completion on B.
  await waitBlobsSettled(["device-b"], { timeoutMs: opts.settleTimeoutMs });

  // 5. BYTE-CORRECTNESS: every .bin materialized on B sha-identical to A; zero failures.
  const [ta, tb] = await Promise.all([a.tree(), b.tree()]);
  const binPaths = Object.keys(ta).filter((p) => p.endsWith(".bin"));
  expect(binPaths.length).toBe(opts.blobCount);
  for (const p of binPaths) {
    expect(tb[p]?.sha256).toBe(ta[p]?.sha256);
  }
  expect((await b.status()).blobs.failed).toBe(0);

  // 6. CAP HELD: the server's concurrent-GET peak stayed within the cap yet showed real concurrency.
  const stats = await readBlobStats();
  console.log(
    `[blob-scale] maxConcurrentGets=${String(stats.maxConcurrentGets)} getCount=${String(stats.getCount)}`,
  );
  expect(stats.maxConcurrentGets).toBeLessThanOrEqual(4); // DEFAULT_BLOB_CONCURRENCY
  expect(stats.maxConcurrentGets).toBeGreaterThanOrEqual(2); // concurrency genuinely used
  return stats.maxConcurrentGets;
}

beforeAll(async () => {
  await resetStack();
  // Both devices boot EMPTY + start: blobs are written LIVE after start (a bootstrap-present blob
  // would never publish — see blob-sync.test.ts header).
  await a.start();
  await b.start();
  await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });
}, 180_000);

afterAll(() => {
  // No partition/crash lever used; nothing to heal.
});

test("blob scale: prose converges before blobs settle; byte-correct; cap held", async () => {
  await runBlobScaleProof({
    prefix: "blobs",
    blobCount: BLOB_COUNT,
    blobSize: BLOB_SIZE,
    proseCount: PROSE_COUNT,
    seedBase: 1,
    decoupleTimeoutMs: 120_000,
    settleTimeoutMs: 180_000,
  });
}, 300_000);

test("blob scale: prose converges — a draining blob batch is never mis-coalesced as a prose rename", async () => {
  // A fresh draining batch on A (distinct prefix/seed so it is NEW to B and actively materializing).
  await resetBlobStats();
  await writeBlobs("batch2", 80, BLOB_SIZE, 100_000);

  // WHILE that batch is still draining on B, rename a prose `.md` on A. The classify pre-filter must
  // ensure a background blob create is NEVER paired as this rename's target.
  const oldProse = "notes/blobs-prose-0.md"; // authored + converged in the first test
  const newProse = "notes/blobs-prose-0-renamed.md";
  await a.rename(oldProse, newProse);

  // Drain the blob batch, then drive FULL convergence (tree incl. blobs equal + prose settled).
  await waitBlobsSettled(["device-b"], { timeoutMs: 180_000 });
  await waitConverged(["device-a", "device-b"], { timeoutMs: 120_000 });

  const [ta, tb] = await Promise.all([a.tree(), b.tree()]);

  // The prose rename converged on B: new path present with A's sha, old gone.
  expect(tb[newProse]?.sha256).toBeDefined();
  expect(tb[newProse]?.sha256).toBe(ta[newProse]?.sha256);
  expect(tb[oldProse]).toBeUndefined();

  // Every .bin blob sha still matches A's (the concurrent rename corrupted nothing).
  const binPaths = Object.keys(ta).filter((p) => p.endsWith(".bin"));
  for (const p of binPaths) {
    expect(tb[p]?.sha256).toBe(ta[p]?.sha256);
  }

  // NO conflict artifact on ANY blob path — a background materialize was never mis-coalesced
  // as the rename target (the classify-pre-filter invariant this test pins).
  const blobArtifacts = conflictArtifacts(tb).filter(
    (p) => p.endsWith(".bin") || p.endsWith(".canvas"),
  );
  expect(blobArtifacts).toEqual([]);
}, 300_000);

// HEAVY @scale variant — opt-in via `pnpm harness:scale` (ZYNC_HARNESS_SCALE=1). Structurally
// identical to the core proof, just larger (443 files / ~300 MB). NOT part of the default gate.
describe("blob scale @scale (heavy, opt-in)", () => {
  test.runIf(SCALE)(
    "blob scale @scale: prose decouples, byte-correct, cap held at 443 files / ~300 MB",
    async () => {
      await runBlobScaleProof({
        prefix: "scale",
        blobCount: SCALE_BLOB_COUNT,
        blobSize: SCALE_BLOB_SIZE,
        proseCount: PROSE_COUNT,
        seedBase: 1_000_000,
        decoupleTimeoutMs: 10 * 60_000,
        settleTimeoutMs: 30 * 60_000,
      });
    },
    40 * 60_000,
  );
});
