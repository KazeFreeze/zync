# `@zync/idb-bench` — headless-Chromium IndexedDB benchmark

Phase-1 **M0 gate #2**: settle, with real desktop-class numbers, whether Zync's engine
persistence should use stock [`y-indexeddb`](https://github.com/yjs/y-indexeddb) (one IDB
database per note → ~1,260 DBs) or a **custom single-DB KV** adapter over the engine's two
storage ports (`DocStorePort` + `EngineStateStore`, see `packages/core/src/ports.ts`).

## What it measures

Two portable persistence candidates, both storing **opaque Yjs snapshots by docId** plus a
small per-doc engine-state record (synced-stamp + dirty bool):

- **Candidate A — stock `y-indexeddb` (`src/candidateA.ts`)**: one `IndexeddbPersistence(docId,
  ydoc)` per note (its native one-DB-per-doc model) + a tiny second per-doc DB for engine-state.
- **Candidate B — single-DB KV (`src/candidateB.ts`)**: ONE IndexedDB database (via
  [`idb`](https://github.com/jakearchibald/idb)) with object stores `docs`, `engine_state`,
  `meta`. save=`put`, load=`get`, list=`getAllKeys`, delete=`delete`.

The candidate **core logic is portable** (browser globals only — `indexedDB`, `performance`,
`navigator.storage`), so the same modules can later be embedded in an Obsidian-mobile command
for the real-device run.

Workload (`src/workload.ts`): a deterministic, seeded corpus of ~1,260 synthetic Yjs docs sized
to mirror the real vault (~2.3–2.9 KB avg, 0.5–15 KB bulk, a few 15–45 KB outliers; no personal
data). Metrics per candidate (median across reps): seed/save-all, **cold open** (fresh context),
list-all-ids, load 20 random, save 100 dirty, delete 100 + re-list, `whenSynced` distribution
(A only), **IDB database count**, `navigator.storage.estimate()` usage/quota, plus a "restart"
reopen pass for durability.

## Run it

```bash
pnpm bench:idb            # from repo root: build bundle + run Playwright (3 reps)
# or, in this dir:
node build.mjs && node runner.mjs
```

Env knobs: `BENCH_REPS` (default 3), `BENCH_HEADED=1` (run against `:0` instead of headless).

The runner serves `public/` over a local http origin (IndexedDB is denied on `file://`/
`about:blank`), launches Chromium (prefers the Playwright-bundled browser; falls back to the
cached `chromium-1223` chrome, then `/usr/bin/brave`), drives each phase via `page.evaluate`,
and writes `idb-bench-results.json` (gitignored). Each candidate runs in its OWN persistent
context; cold-open/list/load phases run in a freshly reopened context so in-memory caches are
genuinely dropped.

## Caveat

These are **desktop-class headless Chromium** numbers. The absolute mobile/Android cold-start +
quota behavior still needs a real-device run — the same portable candidates can be embedded in an
Obsidian-mobile command for that. `indexedDB.databases()` is Chromium/WebKit-only (Firefox lacks
it); the bench flags `-1` where unsupported.
