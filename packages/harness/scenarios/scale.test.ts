/**
 * @scale — Zync ARCHITECTURE GO/NO-GO feasibility suite (Phase 0b-3, Task 6).
 *
 * Drives the user's REAL Obsidian vault (~1253 committed notes, sourced from
 * origin/main by scripts/snapshot-vault.sh into the gitignored `lifeos` fixture)
 * through the live relay + headless devices and records the architecture's scale
 * NUMBERS to metrics.json. This is the feasibility deliverable — the metrics + the
 * pass/fail of each property are the verdict.
 *
 * RUN: `pnpm harness:scale` (compose up --build --wait → vitest -t @scale → down -v).
 * The runner sets ZYNC_HARNESS_SCALE=1 (the selector this file reads) and
 * ZYNC_HARNESS_METRICS (the metrics.json path). HEAVY — many minutes.
 *
 * PRIVACY: this scenario records COUNTS / BYTES / TIMES only — never note content,
 * titles, or real paths. The fixture itself is gitignored and never committed.
 *
 * The four §C goals, as one ordered scenario (single shared stack, single seed):
 *   1. SEED        — device-a loads `lifeos` + syncs ~1253 notes; measure seed time.
 *   2. IDENTICAL   — device-b adopts an IDENTICAL vault with ZERO/near-zero note
 *      ZERO-ATTACH    attaches (the M2 property: content-hash stamps let an identical
 *      (M2)           vault be detected already-synced from the index alone) + the
 *                     doubled-content guard at scale (sampled note sha == A, full
 *                     tree sha-set equality).
 *   3. DIVERGENT-10— a fresh device loads `lifeos-divergent-10` (EXACTLY 10 .md
 *                     changed) → exactly 10 supervised-import inbox entries, the rest
 *                     converge clean. Measure catch-up time.
 *   4. EAGER-vs-LAZY— the honest contrast: the SEED device attached every note doc it
 *                     pushed (eager-ish), the IDENTICAL follower attached ~0 (lazy
 *                     zero-attach). Recorded as attachedDocs + RSS on each.
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  type DeviceName,
  type Tree,
  device,
  resetStack,
  treesEqual,
  waitConverged,
} from "../src/harness.js";

// ── selector: this file only does real work under `pnpm harness:scale` ───────
// The harness runner sets ZYNC_HARNESS_SCALE=1. Run standalone (the full suite),
// the test below is SKIPPED so it never burdens a normal `pnpm harness` run.
const SCALE = process.env.ZYNC_HARNESS_SCALE === "1";
const METRICS_PATH =
  process.env.ZYNC_HARNESS_METRICS ?? new URL("../metrics.json", import.meta.url).pathname;

// 1253 notes over a real relay is SLOW — generous bounds so a live-but-slow run
// settles within one pass rather than flapping a false non-converge.
const SEED_TIMEOUT_MS = 15 * 60_000;
const ADOPT_TIMEOUT_MS = 15 * 60_000;
const DIVERGENT_TIMEOUT_MS = 15 * 60_000;
const TEST_TIMEOUT_MS = 50 * 60_000;

const a = device("device-a");
const b = device("device-b");
const c = device("device-c");

interface InboxEntry {
  id: string;
  kind: string;
  path?: string;
}

interface EagerVsLazy {
  /** Seed device: attached note docs after pushing the whole vault (eager-ish). */
  seedAttachedDocs: number;
  seedRssMb: number;
  /** Identical follower: attached note docs after a zero-attach adopt (lazy). */
  identicalAttachedDocs: number;
  identicalRssMb: number;
  note: string;
}

interface ScaleMetrics {
  noteCount: number;
  seedTimeMs: number;
  serverRssMb: number | "unavailable";
  perDeviceRssMb: Record<string, number>;
  docStoreBytes: Record<string, number>;
  coldStartMs: number;
  connectStormDocs: number;
  indexDocSnapshotBytes: number;
  divergentCatchUpMs: number;
  eagerVsLazy: EagerVsLazy;
  /** Node-fs cold-start is a LOWER bound — NOT a mobile/IndexedDB prediction. */
  coldStartIsLowerBound: true;
  /** doc-count + connect-storm metrics ARE substrate-independent. */
  substrateIndependent: string[];
}

/** Count `.md` (prose) notes in a `/fs/tree` — the convergence-relevant doc set. */
function noteCount(tree: Tree): number {
  return Object.keys(tree).filter((p) => p.toLowerCase().endsWith(".md")).length;
}

/** `docker stats --no-stream` RSS (MiB) for the relay server container, or "unavailable". */
function serverRssMb(): number | "unavailable" {
  try {
    // Resolve the server container name via compose, then read its one-shot mem usage.
    const name = execSync(`docker compose -p zync-harness ps --format '{{.Service}} {{.Name}}'`, {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find(([svc]) => svc === "server")?.[1];
    if (name === undefined) return "unavailable";
    // MemUsage looks like "123.4MiB / 7.5GiB" — parse the used side.
    const usage = execSync(`docker stats --no-stream --format '{{.MemUsage}}' ${name}`, {
      encoding: "utf8",
    }).trim();
    return parseMemToMb(usage.split("/")[0]?.trim() ?? "");
  } catch {
    return "unavailable";
  }
}

/** Parse a docker `MemUsage` token ("123.4MiB", "1.2GiB", "512KiB") to MiB. */
function parseMemToMb(token: string): number {
  const m = /^([\d.]+)\s*([KMG]i?B)$/i.exec(token);
  if (m === null) return 0;
  const value = Number(m[1]);
  const unit = (m[2] ?? "").toUpperCase();
  if (unit.startsWith("G")) return value * 1024;
  if (unit.startsWith("K")) return value / 1024;
  return value; // MiB
}

/**
 * Bounded poll for the EXACTLY-N divergent outcome on device `dev`: the supervised
 * import has surfaced exactly `n` inbox entries AND the device is idle. Drives flush
 * each round (the quiescence lever). Throws a diagnostic on timeout (never hangs).
 */
async function waitDivergentSettled(
  devName: DeviceName,
  n: number,
  peers: DeviceName[],
  timeoutMs: number,
): Promise<number> {
  const dev = device(devName);
  const all = [devName, ...peers].map((x) => device(x));
  const start = Date.now();
  const deadline = start + timeoutMs;
  for (;;) {
    await Promise.all(all.map((d) => d.flush().catch(() => undefined)));
    const status = await dev.status();
    const conflicts = (status.conflicts as InboxEntry[]).filter(
      (e) => e.kind === "supervised-import",
    );
    if (conflicts.length === n && status.pendingDocs === 0) {
      return Date.now() - start;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitDivergentSettled(${devName}) timed out after ${String(timeoutMs)}ms: ` +
          `supervised-import entries=${String(conflicts.length)} (want ${String(n)}), ` +
          `pendingDocs=${String(status.pendingDocs)}`,
      );
    }
    await sleep(2000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── the metrics, assembled across the ordered phases below ───────────────────
const metrics: Partial<ScaleMetrics> = {
  coldStartIsLowerBound: true,
  substrateIndependent: ["noteCount", "connectStormDocs", "indexDocSnapshotBytes"],
};

beforeAll(async () => {
  if (!SCALE) return;
  await resetStack();
}, 5 * 60_000);

afterAll(() => {
  if (!SCALE) return;
  // Persist whatever was gathered (even on a partial/failed run, the numbers are evidence).
  writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2) + "\n");
  console.log(`[scale] metrics → ${METRICS_PATH}\n${JSON.stringify(metrics, null, 2)}`);
});

test.runIf(SCALE)(
  "@scale: real-vault feasibility — seed, identical zero-attach adopt, divergent-10, eager-vs-lazy",
  async () => {
    // ── PHASE 1: SEED — device-a loads the real vault + syncs ~1253 notes ─────
    const seedStart = Date.now();
    await a.loadFixture("lifeos");
    await a.start();
    // Locally converged = device-a alone reaches idle (its whole vault pushed).
    await waitConverged(["device-a"], { timeoutMs: SEED_TIMEOUT_MS, pollMs: 2000 });
    metrics.seedTimeMs = Date.now() - seedStart;

    const treeA = await a.tree();
    metrics.noteCount = noteCount(treeA);
    // The real vault must be the expected order of magnitude (guard a broken fixture).
    expect(metrics.noteCount).toBeGreaterThan(1000);

    const mA = await a.metrics();
    metrics.indexDocSnapshotBytes = mA.indexDocBytes;
    metrics.connectStormDocs = mA.attachedDocs; // docs device-a attached to push the vault
    metrics.serverRssMb = serverRssMb();

    // ── PHASE 2: IDENTICAL ZERO-ATTACH ADOPT (M2) ─────────────────────────────
    // device-b boots EMPTY, connects (receives A's index over the relay), THEN loads
    // a BYTE-IDENTICAL vault and starts. The content-hash stamp lets B detect every
    // note as already-synced from the index + engine-state alone → ~0 note attaches.
    const adoptStart = Date.now();
    await b.loadFixture("lifeos-identical");
    await b.start();
    await waitConverged(["device-a", "device-b"], { timeoutMs: ADOPT_TIMEOUT_MS, pollMs: 2000 });
    const coldStartMs = Date.now() - adoptStart;
    metrics.coldStartMs = coldStartMs;

    const treeB = await b.tree();
    const mB = await b.metrics();

    // ZERO-ATTACH: B adopted an identical vault. The M2 property is that B attaches
    // ~0 NOTE docs (the index alone proves already-synced). "Near-zero" tolerates a
    // tiny number of structural-reconcile attaches at the boundary; the architecture
    // claim is that it is NOT O(noteCount). Assert strictly bounded, well under the
    // doc count, and record the exact number.
    expect(mB.attachedDocs).toBeLessThan(Math.max(10, Math.floor(metrics.noteCount * 0.01)));

    // DOUBLED-CONTENT GUARD AT SCALE: full tree sha-set equality (every path's sha on
    // B == A) AND a sampled note's body sha matches A (no re-seed doubling).
    expect(treesEqual(treeA, treeB)).toBe(true);
    const samplePaths = Object.keys(treeA)
      .filter((p) => p.toLowerCase().endsWith(".md"))
      .sort()
      .filter((_, i) => i % 250 === 0) // a deterministic spread of samples
      .slice(0, 6);
    for (const p of samplePaths) {
      const [docA, docB] = await Promise.all([a.doc(p), b.doc(p)]);
      expect(docB.contentSha256).toBe(docA.contentSha256);
    }

    metrics.perDeviceRssMb = { "device-a": mA.rssMb, "device-b": mB.rssMb };
    metrics.docStoreBytes = { "device-a": mA.docStoreBytes, "device-b": mB.docStoreBytes };

    // ── PHASE 4 (recorded here): EAGER-vs-LAZY contrast ───────────────────────
    // There is no eager-note-attach knob — notes attach LAZILY via catch-up. The
    // honest contrast at scale: the SEED device attached every note doc it pushed
    // (eager-ish, connectStormDocs ≈ noteCount), while the IDENTICAL follower
    // attached ~0 (lazy zero-attach) yet converged byte-for-byte. RSS on each shows
    // the memory cost of holding the doc set attached vs not.
    metrics.eagerVsLazy = {
      seedAttachedDocs: mA.attachedDocs,
      seedRssMb: mA.rssMb,
      identicalAttachedDocs: mB.attachedDocs,
      identicalRssMb: mB.rssMb,
      note:
        "No eager knob exists; the contrast is the seed device (attached every pushed " +
        "note doc) vs the identical-adopt follower (zero-attach). attachedDocs + RSS are " +
        "the honest measure of attach-all vs lazy zero-attach at scale.",
    };
    // The contrast must be REAL: the seed attached many more docs than the follower.
    expect(mA.attachedDocs).toBeGreaterThan(mB.attachedDocs);

    // ── PHASE 3: DIVERGENT-10 ─────────────────────────────────────────────────
    // device-c boots EMPTY, connects, loads a vault where EXACTLY 10 .md files differ
    // from the relay's content (a marker appended). Each divergent note routes to a
    // supervised import → exactly 10 inbox entries; the rest converge clean. We assert
    // exactly-10 + measure catch-up time.
    await c.loadFixture("lifeos-divergent-10");
    await c.start();
    metrics.divergentCatchUpMs = await waitDivergentSettled(
      "device-c",
      10,
      ["device-a", "device-b"],
      DIVERGENT_TIMEOUT_MS,
    );

    // Re-read RSS/docstore for c too (the third device's footprint at scale).
    // perDeviceRssMb / docStoreBytes were assigned in Phase 2 (always runs first).
    const mC = await c.metrics();
    metrics.perDeviceRssMb["device-c"] = mC.rssMb;
    metrics.docStoreBytes["device-c"] = mC.docStoreBytes;

    // Final explicit assertion that the divergent count is exactly 10 (the verdict line).
    const finalC = (await c.status()).conflicts as InboxEntry[];
    expect(finalC.filter((e) => e.kind === "supervised-import").length).toBe(10);
  },
  TEST_TIMEOUT_MS,
);
