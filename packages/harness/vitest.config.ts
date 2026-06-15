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
 * they must run SINGLE-THREADED — no parallel files, no parallel tests — and
 * with a long timeout because container network ops + convergence are slow.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    include: ["scenarios/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
