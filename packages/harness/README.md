# @zync/harness — headless multi-device Docker harness

End-to-end conformance scenarios that drive **real** containers (a relay + MinIO +
several headless device daemons) through the Zync sync engine and assert convergence,
conflict handling, crash recovery, classification gating, and blob sync.

## One command

```sh
pnpm harness
```

That is the whole contract: **one command, one exit code, two artifacts.** It is
drivable by an LLM or by CI — run it, check the exit code, read the artifacts.

What it does (`packages/harness/scripts/run.ts`):

1. `docker compose -p zync-harness up -d --build --wait` — build fresh images and block
   until every container's healthcheck is green.
2. Run the harness vitest suite with **two reporters**: `default` (human-readable, on
   stdout) and `json` (machine-readable → `results.json`).
3. On a **non-zero** vitest run, dump `docker compose logs` → `logs.txt` so the failure
   is debuggable.
4. **Always** tear the stack down (`down -v`) afterwards — unless `--keep` is passed.
5. **Exit with vitest's exit code** (0 = every scenario passed).

### Exit code & artifacts

| | |
|---|---|
| **exit code** | vitest's code — `0` all green, non-zero on a test OR infra failure |
| `results.json` | vitest JSON (per-scenario pass/fail) — written whenever vitest ran |
| `logs.txt` | full `docker compose logs` — written **only on failure** |
| `metrics.json` | scale-run metrics — written **only** by the `--scale` path (Task 6) |

A green run removes any stale `logs.txt` from a prior failed run, so its presence is an
honest signal that the **most recent** run failed.

## Flags & arg pass-through

```sh
pnpm harness -- -t "quiescence"   # forward extra args to vitest → run one scenario
pnpm harness -- --keep            # leave the stack UP after the run (debugging)
pnpm harness:scale                # run only @scale-tagged scenario(s) (Task 6)
```

Everything after `--` that is **not** `--keep` / `--scale` is forwarded verbatim to
vitest. `--keep` and `--scale` are consumed by the runner (not forwarded). With
`--keep`, the runner prints how to inspect and later tear down the stack.

## `--scale` (Task 6 plumbing)

`pnpm harness:scale` filters the suite to `@scale`-tagged scenarios (via vitest's
`-t "@scale"`), runs with `--passWithNoTests`, and points the scale metrics output at
`metrics.json` (exported to the scenario as the `ZYNC_HARNESS_METRICS` env var, with
`ZYNC_HARNESS_SCALE=1` as the selector the scenario reads).

The scale **scenario** itself is Task 6 and is not built yet. Until it lands,
`pnpm harness:scale` exits **0** with a clear `no @scale scenarios yet (Task 6)`
message rather than erroring.

## Note

These scenarios are slow and require Docker, so the **root** `pnpm verify` excludes
`packages/harness/**` — they only run via `pnpm harness`. The runner itself is a
`tsx` script and is type-checked by the harness `typecheck`.
