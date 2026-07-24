import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * DEDICATED harness vitest config. The ROOT vitest.config.ts EXCLUDES
 * `packages/harness/**` so these container-driven scenarios never run under
 * `pnpm verify` — they are slow and require Docker. Run them explicitly FROM
 * THE REPO ROOT (so `${PWD}` resolves the build context):
 *
 *   docker compose -p zync-harness -f packages/harness/docker-compose.yml \
 *     up -d --build --wait
 *   pnpm exec vitest run --config packages/harness/vitest.config.ts
 *
 * `root` is pinned to THIS package dir so the `scenarios/**` include resolves
 * regardless of the cwd vitest is launched from (the command above runs from
 * the repo root).
 *
 * Scenarios share ONE compose project (the relay + minio + three devices), so
 * they must run SINGLE-THREADED — no parallel files, no parallel tests.
 *
 * TIMEOUTS: the per-test ceiling MUST exceed each scenario's own internal
 * convergence budget. Some tests `waitConverged` up to 60s, then again up to
 * 120s (≈180s worst case). Under sustained host load — a full ~26-min run with
 * swap pressure + other Docker stacks competing — convergence that is ~3s in
 * isolation can crawl, so a ceiling BELOW the internal budget (the old 120s)
 * let vitest kill a slow-but-correct test before its own guards fired (observed
 * 2026-07-24 on concurrent-create: passed in 2.9s isolated, killed at 120s in
 * the full suite). 300s sits above the worst-case internal budget, so a genuine
 * non-convergence now fails as the scenario's own debuggable "not converged in
 * Nms" — not an opaque vitest timeout. The suite is single-threaded, so the
 * timeout is the ONLY effective lever (there is no parallelism left to cap).
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    include: ["scenarios/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
