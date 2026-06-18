/**
 * Playwright runner (Node, ESM) — orchestrates the IndexedDB benchmark.
 *
 * Methodology it enforces:
 *   - Serves the bundled bench page over a tiny http server (file:// disables some
 *     storage APIs, so we use http://127.0.0.1).
 *   - Runs Candidate A and B each in their OWN persistent browser context
 *     (`launchPersistentContext` with a per-candidate userDataDir) so IndexedDB
 *     actually survives a context close (the durability/cold-open premise).
 *   - For each candidate, REPS times:
 *       wipe -> seed (page 1)
 *       CLOSE the context  (drops in-memory caches; data stays on disk)
 *       REOPEN the context, fresh page  -> coldOpen, listIds, loadRandom, saveDirty
 *       CLOSE + REOPEN again ("restart" pass) -> coldOpen #2 + deleteAndRelist
 *   - Reports per-metric MEDIAN across reps.
 *
 * Browser resolution: prefers the Playwright-bundled Chromium; if the bundled
 * revision is absent, falls back to the cached chromium-1223 chrome, then to Brave.
 *
 * Output: writes `idb-bench-results.json` (gitignored) and prints a table + verdict.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const REPS = Number(process.env.BENCH_REPS ?? 3);
const HEADED = process.env.BENCH_HEADED === "1";
const LOAD_N = 20;
const DIRTY_N = 100;
const DELETE_N = 100;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
};

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = (req.url ?? "/").split("?")[0];
      if (url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      const file = url === "/" ? "index.html" : url.replace(/^\/+/, "");
      const path = join(PUBLIC, file);
      try {
        const body = await readFile(path);
        res.writeHead(200, {
          "content-type": MIME[extname(path)] ?? "application/octet-stream",
          // headless IDB needs a normal secure-ish context; localhost counts as secure.
          "cache-control": "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/** Resolve an executablePath if the bundled Chromium revision isn't installed. */
function resolveExecutable() {
  // Let Playwright use its bundled browser if present.
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return undefined; // use bundled
  } catch {
    /* fall through */
  }
  const cached = join(
    process.env.HOME ?? "",
    ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
  );
  if (existsSync(cached)) return cached;
  if (existsSync("/usr/bin/brave")) return "/usr/bin/brave";
  return undefined;
}

const median = (arr) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const fmt = (n) => (n == null || Number.isNaN(n) ? "—" : n.toFixed(1));

async function openContext(userDataDir, exe, port) {
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    ...(exe ? { executablePath: exe } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => console.error("  [pageerror]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  [console.error]", m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.zyncBench !== "undefined", null, {
    timeout: 30_000,
  });
  return { ctx, page };
}

async function runCandidate(which, exe, port) {
  const userDataDir = await mkdtemp(join(tmpdir(), `zync-idb-${which}-`));
  const reps = [];
  let config = null;

  try {
    for (let r = 0; r < REPS; r++) {
      // --- page 1: wipe + seed ---
      let { ctx, page } = await openContext(userDataDir, exe, port);
      if (!config) {
        config = await page.evaluate(() => window.zyncBench.config());
      }
      await page.evaluate(() => window.zyncBench.wipe());
      const seed = await page.evaluate((w) => window.zyncBench.seed(w), which);
      await ctx.close(); // drop in-memory caches; on-disk IDB persists in userDataDir

      // --- page 2 (fresh context): cold open + list + load + save-dirty ---
      ({ ctx, page } = await openContext(userDataDir, exe, port));
      const coldOpen = await page.evaluate((w) => window.zyncBench.coldOpen(w), which);
      const listIds = await page.evaluate((w) => window.zyncBench.listIds(w), which);
      const loadRandom = await page.evaluate(
        ([w, n]) => window.zyncBench.loadRandom(w, n),
        [which, LOAD_N],
      );
      const saveDirty = await page.evaluate(
        ([w, n]) => window.zyncBench.saveDirty(w, n),
        [which, DIRTY_N],
      );
      await ctx.close();

      // --- page 3 (restart pass): cold open #2 + delete + relist ---
      ({ ctx, page } = await openContext(userDataDir, exe, port));
      const coldOpen2 = await page.evaluate((w) => window.zyncBench.coldOpen(w), which);
      const deleteRelist = await page.evaluate(
        ([w, n]) => window.zyncBench.deleteAndRelist(w, n),
        [which, DELETE_N],
      );
      await ctx.close();

      reps.push({ seed, coldOpen, listIds, loadRandom, saveDirty, coldOpen2, deleteRelist });
      console.log(
        `  ${which} rep ${r + 1}/${REPS}: seed=${fmt(seed.ms)}ms ` +
          `cold=${fmt(coldOpen.ms)}ms list=${fmt(listIds.ms)}ms ` +
          `load20=${fmt(loadRandom.ms)}ms save100=${fmt(saveDirty.ms)}ms ` +
          `del100=${fmt(deleteRelist.ms)}ms dbs=${seed.dbCountAfter}`,
      );
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  const pick = (sel) => reps.map(sel);
  const agg = {
    name: reps[0] ? null : which,
    config,
    reps: reps.length,
    seedMs: median(pick((r) => r.seed.ms)),
    coldOpenMs: median(pick((r) => r.coldOpen.ms)),
    coldOpen2Ms: median(pick((r) => r.coldOpen2.ms)),
    listMs: median(pick((r) => r.listIds.ms)),
    loadRandomMs: median(pick((r) => r.loadRandom.ms)),
    saveDirtyMs: median(pick((r) => r.saveDirty.ms)),
    deleteRelistMs: median(pick((r) => r.deleteRelist.ms)),
    dbCountAfterSeed: median(pick((r) => r.seed.dbCountAfter)),
    docDbCount: median(pick((r) => r.seed.docDbCount)),
    usageBytes: median(pick((r) => r.seed.usageBytes)),
    quotaBytes: median(pick((r) => r.seed.quotaBytes)),
    whenSyncedMedian: median(
      pick((r) => r.coldOpen.whenSyncedMedian ?? r.seed.whenSyncedMedian ?? NaN),
    ),
    whenSyncedP95: median(pick((r) => r.coldOpen.whenSyncedP95 ?? r.seed.whenSyncedP95 ?? NaN)),
    whenSyncedMax: median(pick((r) => r.coldOpen.whenSyncedMax ?? r.seed.whenSyncedMax ?? NaN)),
    remainingAfterDelete: median(pick((r) => r.deleteRelist.remaining)),
    raw: reps,
  };
  return agg;
}

async function main() {
  const exe = resolveExecutable();
  const { server, port } = await serve();
  console.log(
    `[runner] serving ${PUBLIC} on :${port}; reps=${REPS}; headed=${HEADED}; ` +
      `exe=${exe ?? "playwright-bundled"}`,
  );

  let version = "unknown";
  let A, B;
  try {
    A = await (async () => {
      console.log("[runner] Candidate A — stock y-indexeddb");
      return runCandidate("A", exe, port);
    })();
    B = await (async () => {
      console.log("[runner] Candidate B — single-DB KV (idb)");
      return runCandidate("B", exe, port);
    })();

    // grab the browser version from a throwaway context
    const tmp = await chromium.launchPersistentContext(
      await mkdtemp(join(tmpdir(), "zync-idb-ver-")),
      { headless: !HEADED, ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox"] },
    );
    version = tmp.browser()?.version() ?? "unknown";
    await tmp.close();
  } finally {
    server.close();
  }

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      browser: version,
      executable: exe ?? "playwright-bundled-chromium",
      headed: HEADED,
      reps: REPS,
      loadN: LOAD_N,
      dirtyN: DIRTY_N,
      deleteN: DELETE_N,
      corpus: A.config,
    },
    candidateA: A,
    candidateB: B,
  };

  const outPath = join(__dirname, "idb-bench-results.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  printReport(results);
  console.log(`\n[runner] wrote ${outPath}`);
}

function printReport(r) {
  const A = r.candidateA;
  const B = r.candidateB;
  const row = (label, a, b, unit = "ms") =>
    `${label.padEnd(28)} ${String(a).padStart(12)} ${String(b).padStart(12)}   ${unit}`;
  console.log("\n================ RESULTS (median across reps) ================");
  console.log(`Browser: ${r.meta.browser}   reps: ${r.meta.reps}`);
  console.log(
    `Corpus: ${r.meta.corpus.stats.count} docs, ` +
      `avg ${r.meta.corpus.stats.avgBytes}B, total ${(r.meta.corpus.stats.totalBytes / 1e6).toFixed(2)}MB\n`,
  );
  console.log(`${"metric".padEnd(28)} ${"A (y-idb)".padStart(12)} ${"B (KV)".padStart(12)}`);
  console.log("-".repeat(70));
  console.log(row("seed/save all", fmt(A.seedMs), fmt(B.seedMs)));
  console.log(row("cold open", fmt(A.coldOpenMs), fmt(B.coldOpenMs)));
  console.log(row("cold open (restart)", fmt(A.coldOpen2Ms), fmt(B.coldOpen2Ms)));
  console.log(row("list all ids", fmt(A.listMs), fmt(B.listMs)));
  console.log(row(`load ${LOAD_N} random`, fmt(A.loadRandomMs), fmt(B.loadRandomMs)));
  console.log(row(`save ${DIRTY_N} dirty`, fmt(A.saveDirtyMs), fmt(B.saveDirtyMs)));
  console.log(row(`delete ${DELETE_N}+relist`, fmt(A.deleteRelistMs), fmt(B.deleteRelistMs)));
  console.log(row("IDB doc-snapshot DBs", A.docDbCount, B.docDbCount, "dbs"));
  console.log(row("IDB total DB count", A.dbCountAfterSeed, B.dbCountAfterSeed, "dbs"));
  console.log(
    row("storage usage", (A.usageBytes / 1e6).toFixed(2), (B.usageBytes / 1e6).toFixed(2), "MB"),
  );
  console.log(row("whenSynced median", fmt(A.whenSyncedMedian), "n/a"));
  console.log(row("whenSynced p95", fmt(A.whenSyncedP95), "n/a"));
  console.log(row("whenSynced max", fmt(A.whenSyncedMax), "n/a"));
  console.log("-".repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
