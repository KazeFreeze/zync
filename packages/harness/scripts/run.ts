/**
 * `pnpm harness` — one-command Zync headless-harness orchestration (Phase 0b-3, Task 7).
 *
 * CONTRACT (drivable by an LLM or CI): ONE command, ONE exit code, TWO artifacts.
 *
 *   pnpm harness                  # build + up --wait → run FULL suite → down -v
 *   pnpm harness -- -t "pattern"  # forward extra args to vitest (run one scenario)
 *   pnpm harness -- --keep        # leave the stack UP after the run (debugging)
 *   pnpm harness:scale            # run only @scale-tagged scenario(s) (Task 6)
 *
 * Exit code  : vitest's exit code — 0 = every scenario passed, non-zero = failure
 *              (or an infra failure: a build/up that never goes healthy also exits
 *              non-zero, after dumping logs + tearing down).
 * results.json: vitest's JSON reporter output (per-scenario pass/fail) — ALWAYS
 *              written when vitest ran (pass OR fail). Path: packages/harness/results.json.
 * logs.txt    : `docker compose logs` — written ON FAILURE only (build/up failure
 *              OR a non-zero vitest run) so a red run is debuggable. Path:
 *              packages/harness/logs.txt. A green run does NOT write it (and removes
 *              any stale copy from a prior red run).
 * metrics.json: ONLY the `--scale` path points here (Task 6 scale scenario writes it).
 *
 * FLOW:
 *   1. docker compose -p zync-harness up -d --build --wait   (build fresh, block healthy)
 *      └─ on failure: dump compose logs → logs.txt, tear down, exit non-zero.
 *   2. vitest run --reporter=default --reporter=json --outputFile.json=results.json
 *      (human-readable on stdout AND machine-readable JSON file). Capture exit code.
 *   3. on non-zero vitest: dump compose logs → logs.txt (debuggable failure).
 *   4. ALWAYS tear down (down -v) in a finally — UNLESS --keep was passed.
 *   5. exit with vitest's exit code.
 *
 * ARG PASS-THROUGH: everything after the script's own flags (--keep / --scale) is
 * forwarded verbatim to vitest, so `pnpm harness -- -t "quiescence"` runs just that
 * scenario. `--keep` and `--scale` are consumed here (NOT forwarded).
 *
 * --scale PLUMBING (Task 6 is NOT built yet): `--scale` filters the suite to the
 * `@scale`-tagged scenario(s) via vitest's `-t "@scale"` testNamePattern and points
 * the scale metrics output at packages/harness/metrics.json (exported to the future
 * scenario as ZYNC_HARNESS_METRICS so it just writes there). If NO @scale scenario
 * exists today, this exits 0 with a clear "no @scale scenarios yet (Task 6)" message
 * — it must NOT error. (vitest's `--passWithNoTests` makes the no-match run green.)
 *
 * This script lives OUTSIDE the engine firewall (harness orchestration only) and is
 * run via tsx — it is NOT executed by root `pnpm verify`'s vitest (which excludes
 * packages/harness/**). It is type-checked by the harness `typecheck` script.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";
import { execa, type ExecaError } from "execa";

// ── paths / constants ────────────────────────────────────────────────────────

/** Compose project name — MUST match the `-p` used everywhere else in the harness. */
const PROJECT = "zync-harness";

/** Absolute path to the harness package root (this file lives in `scripts/`). */
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Repo root — the compose build context (`packages/harness/` → `../..`). */
const REPO_ROOT = dirname(dirname(HARNESS_ROOT));

const COMPOSE_FILE = join(HARNESS_ROOT, "docker-compose.yml");
const VITEST_CONFIG = join(HARNESS_ROOT, "vitest.config.ts");
const RESULTS_JSON = join(HARNESS_ROOT, "results.json");
const METRICS_JSON = join(HARNESS_ROOT, "metrics.json");
const LOGS_TXT = join(HARNESS_ROOT, "logs.txt");

/** `docker compose -p zync-harness -f <compose>` — the prefix every compose call shares. */
const COMPOSE_ARGS = ["compose", "-p", PROJECT, "-f", COMPOSE_FILE];

/**
 * The compose build context is `${ZYNC_HARNESS_ROOT:-${PWD}}` (an ABSOLUTE repo-root
 * path; see docker-compose.yml). We set it explicitly so this runner works regardless
 * of the cwd it was launched from — mirroring `resetStack` in src/harness.ts.
 */
const COMPOSE_ENV = { ...process.env, ZYNC_HARNESS_ROOT: REPO_ROOT };

// ── arg parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  /** Leave the stack up after the run (skip teardown). */
  keep: boolean;
  /** Run only the @scale-tagged scenario(s) (Task 6). */
  scale: boolean;
  /** Remaining args forwarded verbatim to vitest. */
  vitestArgs: string[];
}

/**
 * Consume the runner's OWN flags (`--keep`, `--scale`) and forward the rest to vitest.
 *
 * `pnpm harness -- -t "quiescence"` reaches the root `harness` script, which delegates
 * via `pnpm --filter @zync/harness harness`; pnpm forwards the trailing args BUT keeps
 * the literal `--` separator, so this script sees `["--", "-t", "quiescence"]`. We drop
 * the FIRST bare `--` (the conventional end-of-options marker — never a real vitest arg)
 * and forward the rest verbatim. `--keep` / `--scale` may appear anywhere and are NOT
 * forwarded.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  let keep = false;
  let scale = false;
  let droppedSeparator = false;
  const vitestArgs: string[] = [];
  for (const arg of argv) {
    if (arg === "--keep") keep = true;
    else if (arg === "--scale") scale = true;
    else if (arg === "--" && !droppedSeparator) droppedSeparator = true;
    else vitestArgs.push(arg);
  }
  return { keep, scale, vitestArgs };
}

// ── compose helpers ──────────────────────────────────────────────────────────

/** Stream a compose command to the console (build/up/down progress is visible live). */
async function composeStreamed(args: readonly string[]): Promise<void> {
  await execa("docker", [...COMPOSE_ARGS, ...args], { env: COMPOSE_ENV, stdio: "inherit" });
}

/** Dump the full compose logs (no color, captured) to logs.txt for a debuggable failure. */
async function dumpLogs(reason: string): Promise<void> {
  try {
    const { stdout } = await execa("docker", [...COMPOSE_ARGS, "logs", "--no-color"], {
      env: COMPOSE_ENV,
      reject: false,
    });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(LOGS_TXT, `# ${reason}\n# ${new Date().toISOString()}\n\n${stdout}\n`);
    console.error(`\n[harness] wrote compose logs → ${LOGS_TXT}`);
  } catch (err) {
    console.error(`[harness] failed to dump compose logs: ${String(err)}`);
  }
}

/** Best-effort teardown: `down -v` (wipes named volumes too — pristine for next run). */
async function teardown(): Promise<void> {
  console.error("\n[harness] tearing down stack (docker compose down -v)…");
  await composeStreamed(["down", "-v", "--remove-orphans"]);
}

// ── vitest invocation ────────────────────────────────────────────────────────

/**
 * Run the harness suite. Two reporters: `default` (human-readable, streamed to stdout)
 * AND `json` (machine-readable, written to results.json via cac dot-notation so it does
 * NOT also dump JSON to stdout). Returns vitest's exit code (never throws on a test
 * failure — a non-zero code is the SIGNAL, not an exception).
 */
async function runVitest(args: ParsedArgs): Promise<number> {
  const vitestArgs = [
    "vitest",
    "run",
    "--config",
    VITEST_CONFIG,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${RESULTS_JSON}`,
  ];

  if (args.scale) {
    // --scale: select ONLY @scale-tagged scenarios (Task 6). `--passWithNoTests` keeps
    // the run GREEN when none exist yet; point the future scenario's metrics output at
    // metrics.json via env. The `-t "@scale"` testNamePattern matches any test whose
    // full name contains the `@scale` tag.
    vitestArgs.push("--passWithNoTests", "-t", "@scale");
    console.error(
      `[harness] --scale: filtering to @scale-tagged scenarios; metrics → ${METRICS_JSON}`,
    );
  }

  // Forward any pass-through args LAST so an explicit `-t` from the caller can override.
  vitestArgs.push(...args.vitestArgs);

  const env = args.scale
    ? { ...process.env, ZYNC_HARNESS_METRICS: METRICS_JSON, ZYNC_HARNESS_SCALE: "1" }
    : process.env;

  console.error(`[harness] running: pnpm exec ${vitestArgs.join(" ")}`);
  const result = await execa("pnpm", ["exec", ...vitestArgs], {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
    reject: false,
  });
  return result.exitCode ?? 1;
}

// ── scale no-op detection ────────────────────────────────────────────────────

/**
 * After a `--scale` run, decide whether it was a clean "no @scale scenarios yet" no-op.
 * Task 6 hasn't landed, so today there are no `@scale` tests: vitest exits 0 (via
 * `--passWithNoTests`) and writes a results.json with zero tests. We surface that as a
 * clear message rather than a silent green, and confirm metrics.json was NOT produced.
 */
function reportScaleNoOp(vitestCode: number): void {
  if (vitestCode !== 0) return;
  if (existsSync(METRICS_JSON)) {
    console.error(`[harness] --scale: metrics written → ${METRICS_JSON}`);
    return;
  }
  console.error(
    "\n[harness] --scale: no @scale scenarios yet (Task 6 not built) — nothing to run.\n" +
      "          When Task 6 lands a `@scale`-tagged scenario it will run here and write\n" +
      `          its metrics to ${METRICS_JSON}.`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Fresh run: clear any stale logs.txt from a prior FAILED run so its presence is an
  // honest signal of THIS run's outcome.
  if (existsSync(LOGS_TXT)) rmSync(LOGS_TXT);
  if (args.scale && existsSync(METRICS_JSON)) rmSync(METRICS_JSON);

  // ── 1. build + bring the stack up, blocking until every healthcheck is green ──
  console.error("[harness] docker compose up -d --build --wait (this can take a few minutes)…");
  try {
    await composeStreamed(["up", "-d", "--build", "--wait"]);
  } catch (err) {
    const e = err as ExecaError;
    console.error(`\n[harness] compose up/build FAILED (exit ${String(e.exitCode ?? "?")}).`);
    await dumpLogs("compose up/build failed");
    await teardown();
    return typeof e.exitCode === "number" && e.exitCode !== 0 ? e.exitCode : 1;
  }

  // ── 2..5. run vitest; logs on failure; ALWAYS tear down (finally); exit code ──
  let vitestCode = 1;
  try {
    vitestCode = await runVitest(args);

    if (vitestCode !== 0) {
      console.error(`\n[harness] vitest FAILED (exit ${String(vitestCode)}).`);
      await dumpLogs(`vitest failed (exit ${String(vitestCode)})`);
    } else if (args.scale) {
      reportScaleNoOp(vitestCode);
    }
  } finally {
    if (args.keep) {
      console.error(
        `\n[harness] --keep: leaving the stack UP.\n` +
          `          inspect : docker compose -p ${PROJECT} -f ${COMPOSE_FILE} ps\n` +
          `          logs    : docker compose -p ${PROJECT} -f ${COMPOSE_FILE} logs -f\n` +
          `          tear down: docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down -v`,
      );
    } else {
      await teardown();
    }
  }

  // ── report the contract artifacts ──
  if (existsSync(RESULTS_JSON)) console.error(`[harness] results → ${RESULTS_JSON}`);
  console.error(`[harness] exit ${String(vitestCode)}`);
  return vitestCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`[harness] unexpected error: ${String(err)}`);
    process.exitCode = 1;
  });
