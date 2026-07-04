/**
 * Harness helper for the Zync headless Docker harness (Phase 0b-3, Task 4).
 *
 * Scenarios drive REAL containers through this module:
 *   - {@link Device} — a typed client over a device's published control API
 *     (`http://localhost:<port>`): fs mutations, sync lifecycle, tree/status/doc
 *     reads, editor panes, metrics.
 *   - {@link partition}/{@link heal} — the OFFLINE lever: disconnect/connect the
 *     device container from `zync-harness_syncnet` (its control API stays
 *     reachable because that is a host-published port on controlnet).
 *   - {@link crash}/{@link restart} — SIGKILL / compose-start a device.
 *   - {@link waitConverged} — the core assertion primitive: poll until ALL named
 *     devices have an IDENTICAL `/fs/tree` sha-map AND every device reports
 *     `pendingDocs === 0`. Bounded; throws a diagnostic dump on timeout.
 *
 * No `any`. Control-API response shapes are declared locally (the control API is
 * framework-free JSON; we type the slice we read).
 */

import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

// ── compose / docker constants ──────────────────────────────────────────────

/** Compose project name — must match the `-p` flag used to bring the stack up. */
export const PROJECT = "zync-harness";

/** Absolute path to the harness package root (this file lives in `src/`). */
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Absolute path to the compose file the levers + reset drive. */
const COMPOSE_FILE = join(HARNESS_ROOT, "docker-compose.yml");

/** Repo root — the build context (`packages/harness/` → `../..`). */
const REPO_ROOT = dirname(dirname(HARNESS_ROOT));

/** `docker compose -p zync-harness -f <compose>` arg prefix shared by every lever. */
const COMPOSE_ARGS = ["compose", "-p", PROJECT, "-f", COMPOSE_FILE];

/** The partitionable network (device <-> server sync traffic). */
const SYNCNET = `${PROJECT}_syncnet`;

/** Logical device name → published control-API port (compose `ports:` map). */
const CONTROL_PORTS: Record<DeviceName, number> = {
  "device-a": 17070,
  "device-b": 17071,
  "device-c": 17072,
  "device-proj": 17073,
};

export type DeviceName = "device-a" | "device-b" | "device-c" | "device-proj";

/**
 * Host base URL for the relay server's blob endpoint (compose publishes server
 * `:8080` → host `:18080`). Direct-PUT scenarios (hash-on-write reject) target this.
 */
export const SERVER_BLOB_BASE = "http://localhost:18080";

/**
 * The static auth token the compose stack shares across the relay + blob endpoint
 * + every device (`ZYNC_TOKEN` in docker-compose.yml). Direct-fetch blob scenarios
 * must send `Authorization: Bearer ${SERVER_TOKEN}` — the endpoint 401s without it.
 */
export const SERVER_TOKEN = "dev-static-token";

/** Auth header object for direct fetches at the blob endpoint. */
export const blobAuthHeader: Readonly<Record<string, string>> = {
  Authorization: `Bearer ${SERVER_TOKEN}`,
};

// ── control-API response shapes (the slices the harness reads) ──────────────

/** `GET /fs/tree` → path → content digest. The convergence-assertion surface. */
export type Tree = Record<string, { sha256: string; size: number }>;

export type ConnStatus = "connected" | "connecting" | "offline" | "unauthorized";

/** `GET /status`. */
export interface Status {
  conn: ConnStatus;
  pendingDocs: number;
  conflicts: unknown[];
  writeCount: number;
  ingestCount: number;
  lastSyncAt: number | null;
  blobs: { materialized: number; total: number; failed: number; settled: boolean };
}

/** `GET /doc?path=`. */
export interface DocInfo {
  docId: string | null;
  /** Raw tombstone flag of the index entry; `null` when there is no entry (disk-only). */
  deleted: boolean | null;
  /** The entry exists AND is not tombstoned — a TRUE live doc (vs. a tombstoned old key). */
  live: boolean;
  text: string;
  contentSha256: string;
  baseHash: string | null;
  fsmState: string;
}

/** `GET /metrics`. */
export interface Metrics {
  rssMb: number;
  docStoreBytes: number;
  indexDocBytes: number;
  attachedDocs: number;
}

// ── Device — control-API client ─────────────────────────────────────────────

/**
 * A typed client over one device's published control API. Construct via
 * {@link device}. Every method is a thin fetch over `http://localhost:<port>`.
 */
export class Device {
  readonly name: DeviceName;
  readonly port: number;
  private readonly base: string;

  constructor(name: DeviceName) {
    this.name = name;
    this.port = CONTROL_PORTS[name];
    this.base = `http://localhost:${String(this.port)}`;
  }

  /** The compose-assigned container name (resolved lazily, cached). */
  private containerNameCache: string | null = null;

  async containerName(): Promise<string> {
    this.containerNameCache ??= await resolveContainer(this.name);
    return this.containerNameCache;
  }

  // -- sync lifecycle --------------------------------------------------------

  loadFixture(fixture: string, variant?: string): Promise<void> {
    const body = variant === undefined ? { fixture } : { fixture, variant };
    return this.postOk("/vault/load", body);
  }

  start(): Promise<void> {
    return this.postOk("/sync/start", {});
  }

  stop(): Promise<void> {
    return this.postOk("/sync/stop", {});
  }

  flush(): Promise<void> {
    return this.postOk("/sync/flush", {});
  }

  // -- fs mutations (external-writer simulation) -----------------------------

  write(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    return this.postOk("/fs/write", { path, contentBase64: bytes.toString("base64") });
  }

  edit(
    args: { path: string; find: string; replace: string } | { path: string; append: string },
  ): Promise<void> {
    return this.postOk("/fs/edit", args);
  }

  rename(from: string, to: string): Promise<void> {
    return this.postOk("/fs/rename", { from, to });
  }

  del(path: string): Promise<void> {
    return this.postOk("/fs/delete", { path });
  }

  /** Resolve a content conflict via the engine's resolveContentConflict (keep-current | keep-backup). */
  resolveContentConflict(id: string, action: "keep-current" | "keep-backup"): Promise<void> {
    return this.postOk("/inbox/resolve-content", { id, action });
  }

  // -- reads -----------------------------------------------------------------

  async read(path: string): Promise<string> {
    const out = await this.getJson<{ contentBase64: string }>(
      `/fs/read?path=${encodeURIComponent(path)}`,
    );
    return Buffer.from(out.contentBase64, "base64").toString("utf8");
  }

  /**
   * BINARY-safe read: returns the raw vault bytes (no UTF-8 round-trip, which would
   * corrupt a binary blob). Used by blob scenarios to compare bytes/sha across devices.
   */
  async readBytes(path: string): Promise<Uint8Array> {
    const out = await this.getJson<{ contentBase64: string }>(
      `/fs/read?path=${encodeURIComponent(path)}`,
    );
    return new Uint8Array(Buffer.from(out.contentBase64, "base64"));
  }

  /** True iff `path` exists in this device's vault (a `/fs/read` that 404s ⇒ false). */
  async exists(path: string): Promise<boolean> {
    const res = await fetch(`${this.base}/fs/read?path=${encodeURIComponent(path)}`);
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw new Error(`${this.name} GET /fs/read?path=${path} → ${String(res.status)}`);
  }

  tree(): Promise<Tree> {
    return this.getJson<Tree>("/fs/tree");
  }

  status(): Promise<Status> {
    return this.getJson<Status>("/status");
  }

  doc(path: string): Promise<DocInfo> {
    return this.getJson<DocInfo>(`/doc?path=${encodeURIComponent(path)}`);
  }

  metrics(): Promise<Metrics> {
    return this.getJson<Metrics>("/metrics");
  }

  // -- editor panes ----------------------------------------------------------

  editorOpen(path: string, paneId?: string): Promise<void> {
    return this.postOk("/editor/open", paneId === undefined ? { path } : { path, paneId });
  }

  editorType(args: {
    path: string;
    at: number;
    paneId?: string;
    text?: string;
    del?: number;
    ins?: string;
  }): Promise<void> {
    return this.postOk("/editor/type", args);
  }

  editorClose(path: string, paneId?: string): Promise<void> {
    return this.postOk("/editor/close", paneId === undefined ? { path } : { path, paneId });
  }

  // -- transport -------------------------------------------------------------

  private async postOk(route: string, body: unknown): Promise<void> {
    const res = await fetch(this.base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.name} POST ${route} → ${String(res.status)}: ${text}`);
    }
  }

  private async getJson<T>(route: string): Promise<T> {
    const res = await fetch(this.base + route);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.name} GET ${route} → ${String(res.status)}: ${text}`);
    }
    return (await res.json()) as T;
  }
}

/** Construct a {@link Device} client for `name` (a→17070, b→17071, c→17072). */
export function device(name: DeviceName): Device {
  return new Device(name);
}

// ── docker levers ───────────────────────────────────────────────────────────

/**
 * Resolve the running container name for a logical device service via
 * `docker compose -p zync-harness ps`. Compose v2+ names containers
 * `zync-harness-device-a-1`, but we read the actual name to be version-proof.
 */
async function resolveContainer(name: DeviceName): Promise<string> {
  const { stdout } = await execa("docker", [
    "compose",
    "-p",
    PROJECT,
    "ps",
    "--format",
    "{{.Service}} {{.Name}}",
  ]);
  for (const line of stdout.split("\n")) {
    const [service, container] = line.trim().split(/\s+/);
    if (service === name && container !== undefined && container !== "") return container;
  }
  throw new Error(`could not resolve container for ${name}; ps output:\n${stdout}`);
}

/** OFFLINE lever: cut a device off syncnet (control API on controlnet survives). */
export async function partition(name: DeviceName): Promise<void> {
  const container = await resolveContainer(name);
  await execa("docker", ["network", "disconnect", SYNCNET, container]);
}

/** Heal a partition: reconnect the device to syncnet. */
export async function heal(name: DeviceName): Promise<void> {
  const container = await resolveContainer(name);
  await execa("docker", ["network", "connect", SYNCNET, container]);
}

/**
 * OUT-OF-BAND filesystem op inside a device's `/vault`, via `docker exec`. Use it (with the daemon
 * STOPPED via `device.stop()`) to model changes made while the app was CLOSED — e.g. an AI/terminal
 * `rm`/`mv` in the vault dir. These bypass the engine + the watcher entirely, so on the next
 * `/sync/start` they are seen ONLY by bootstrap. Example: `vaultExec("device-a", ["rm", "/vault/notes/x.md"])`.
 */
export async function vaultExec(name: DeviceName, argv: string[]): Promise<void> {
  const container = await resolveContainer(name);
  await execa("docker", ["exec", container, ...argv]);
}

/** SIGKILL a device container (no graceful shutdown). */
export async function crash(name: DeviceName): Promise<void> {
  const container = await resolveContainer(name);
  await execa("docker", ["kill", "-s", "KILL", container]);
}

/**
 * Restart a previously-crashed/stopped device via compose, then BLOCK until its
 * control-API healthcheck reports healthy again (`--wait`). The daemon boots IDLE
 * after a restart — the caller must re-issue `POST /sync/start` to re-attach the
 * transport and let the engine re-push its persisted dirty-set.
 */
export async function restart(name: DeviceName): Promise<void> {
  await execa("docker", [...COMPOSE_ARGS, "start", name]);
  await execa("docker", [...COMPOSE_ARGS, "up", "-d", "--wait", "--no-recreate", name]);
}

/**
 * Resolve the running container name for the relay `server` service (it is NOT a
 * {@link DeviceName}, so it has no control port — the crash levers target it by
 * compose service name).
 */
async function resolveServerContainer(): Promise<string> {
  const { stdout } = await execa("docker", [
    ...COMPOSE_ARGS,
    "ps",
    "--format",
    "{{.Service}} {{.Name}}",
  ]);
  for (const line of stdout.split("\n")) {
    const [service, container] = line.trim().split(/\s+/);
    if (service === "server" && container !== undefined && container !== "") return container;
  }
  throw new Error(`could not resolve server container; ps output:\n${stdout}`);
}

/** SIGKILL the relay server container (no graceful shutdown). */
export async function crashServer(): Promise<void> {
  const container = await resolveServerContainer();
  await execa("docker", ["kill", "-s", "KILL", container]);
}

/**
 * Restart the previously-crashed server via compose and BLOCK until its relay-port
 * healthcheck reports healthy (`--wait`). On boot the relay reloads each doc's
 * persisted Yjs snapshot via `onLoadDocument` from its durable snapshot volume.
 */
export async function restartServer(): Promise<void> {
  await execa("docker", [...COMPOSE_ARGS, "start", "server"]);
  await execa("docker", [...COMPOSE_ARGS, "up", "-d", "--wait", "--no-recreate", "server"]);
}

/**
 * Read a JSON file out of a (device) container for crash diagnostics — e.g. the
 * post-restart `engine-state.json` (dirty-set + synced-stamps). Returns the raw
 * file text. Throws if the path is absent (a freshly-wiped store) so a caller can
 * distinguish "no state" from "empty state".
 */
export async function readContainerFile(name: DeviceName, absPath: string): Promise<string> {
  const container = await resolveContainer(name);
  const { stdout } = await execa("docker", ["exec", container, "cat", absPath]);
  return stdout;
}

/** Tail a container's logs (server or device) for crash-finding documentation. */
export async function containerLogs(
  service: DeviceName | "server",
  tailLines = 80,
): Promise<string> {
  const { stdout, stderr } = await execa("docker", [
    ...COMPOSE_ARGS,
    "logs",
    "--tail",
    String(tailLines),
    service,
  ]);
  return `${stdout}\n${stderr}`;
}

// ── stack reset (per-scenario isolation) ─────────────────────────────────────

/**
 * RECREATE the whole stack so each scenario starts from a pristine relay + empty
 * device vaults. `down -v` wipes the relay's snapshot volume (its persisted index +
 * note docs) and removes the device containers (their tmpfs vaults); `up --wait`
 * brings everything back healthy. This is the ROBUST isolation primitive: scenarios
 * share one compose project, and a relay still holding a PRIOR scenario's docs would
 * turn a fresh seed into spurious concurrent-create conflicts. Images are reused
 * (no `--build`), so a reset is just teardown + boot.
 *
 * Run from the repo ROOT (the build context defaults to `${PWD}`); we set it
 * explicitly so a reset works regardless of the cwd vitest launched from.
 */
export async function resetStack(): Promise<void> {
  const env = { ...process.env, ZYNC_HARNESS_ROOT: REPO_ROOT };
  await execa("docker", [...COMPOSE_ARGS, "down", "-v", "--remove-orphans"], { env });
  await execa("docker", [...COMPOSE_ARGS, "up", "-d", "--wait"], { env });
}

/**
 * SINGLE-SEED onboarding: ONE device loads the fixture, the rest boot EMPTY and pull it
 * over the relay. This is the realistic multi-device flow AND the correctness keystone —
 * if every device loaded the same fixture independently each would mint its OWN docIds for
 * identical paths, and the index-doc reconcile would (correctly) treat every note as a
 * concurrent-create conflict. Seeding once means the followers receive the SAME docIds.
 *
 * Loads on `seed`, starts `seed` first, then starts every other device, then waits for the
 * whole set to converge (followers materialize the fixture from the relay).
 */
export async function seedAndStart(
  seed: DeviceName,
  followers: DeviceName[],
  fixture: string,
  options: WaitConvergedOptions = {},
): Promise<void> {
  const seedDev = device(seed);
  await seedDev.loadFixture(fixture);
  await seedDev.start();
  for (const f of followers) await device(f).start();
  await waitConverged([seed, ...followers], { timeoutMs: 60_000, ...options });
}

// ── convergence assertion primitive ─────────────────────────────────────────

export interface WaitConvergedOptions {
  /** Hard bound; throw with a diagnostic dump if not converged by then. */
  timeoutMs?: number;
  /** Poll interval. */
  pollMs?: number;
}

/**
 * Poll until ALL named devices satisfy BOTH:
 *   1. their `/fs/tree` sha-maps are byte-for-byte EQUAL, and
 *   2. every device reports `pendingDocs === 0`.
 *
 * Each poll first DRIVES quiescence via `/sync/flush` on every device (the daemon's
 * flush loops the engine's catch-up until `pendingDocs` settles — see the control-API
 * `syncFlush` note). This is load-bearing over a real relay: the reactive
 * `index.observe → runCatchUp` chain can latch a doc's synced-stamp against an
 * INTERMEDIATE tree stamp mid-conflict-merge, so a purely passive poll would see
 * `pendingDocs === 1` forever even after content has converged. Flush re-reads the
 * final stamp and clears the residue. Flush is best-effort here (a device still
 * offline degrades flush to a drain) so a partitioned device never makes the poll throw.
 *
 * Bounded by `timeoutMs` (default 60s). On timeout, throws an Error whose message dumps
 * each device's pendingDocs + tree so a failure is debuggable — it NEVER hangs.
 *
 * STABILITY (must hold TWICE). A converged sample must REPEAT on the next poll before we
 * return. An EXTERNAL fs mutation (`/fs/delete`, `/fs/rename`, `/fs/write`) is processed
 * by the engine via the ASYNC recursive watcher (a ~20ms coalesce + an fs.stat), so it is
 * NOT yet reflected the instant the control call returns. Without the stability check, the
 * very first poll after such a mutation could observe the OLD-but-equal+idle state (e.g.
 * just after a delete, every device still equally HAS the file and reports idle) and
 * return on a FALSE convergence. Requiring the equal+idle condition to hold across two
 * consecutive polls (pollMs apart, » the watcher latency) lets the pending mutation
 * register on the second poll, so the loop keeps going until the engines have truly
 * absorbed it. (Steady-state cost: one extra `pollMs` — acceptable for correctness.)
 */
export async function waitConverged(
  names: DeviceName[],
  options: WaitConvergedOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 500;
  const devices = names.map((n) => device(n));
  const deadline = Date.now() + timeoutMs;

  let lastTrees = new Map<DeviceName, Tree>();
  let lastPending = new Map<DeviceName, number>();
  let convergedOnce = false;

  for (;;) {
    // Drive quiescence before sampling (see doc). Best-effort: a flush that throws
    // (e.g. a doc that genuinely cannot settle yet) must not abort the bounded poll.
    await Promise.all(devices.map((d) => d.flush().catch(() => undefined)));

    const trees = new Map<DeviceName, Tree>();
    const pending = new Map<DeviceName, number>();
    for (const d of devices) {
      trees.set(d.name, await d.tree());
      pending.set(d.name, (await d.status()).pendingDocs);
    }
    lastTrees = trees;
    lastPending = pending;

    const allIdle = [...pending.values()].every((p) => p === 0);
    const treeList = [...trees.values()];
    const allEqual = treeList.every((t) => treesEqual(t, treeList[0] ?? {}));

    if (allIdle && allEqual) {
      // Require the converged sample to hold across two consecutive polls so a
      // just-issued external mutation (async watcher) cannot pass as false convergence.
      if (convergedOnce) return;
      convergedOnce = true;
    } else {
      convergedOnce = false;
    }

    if (Date.now() >= deadline) {
      throw new Error(convergenceDiagnostic(names, lastTrees, lastPending, timeoutMs));
    }
    await sleep(pollMs);
  }
}

/**
 * Poll until every named device reports `blobs.settled` with zero failures, for TWO consecutive
 * samples (so a momentary mid-enqueue gap can't read as settled). Background blob materialization
 * is decoupled from prose convergence, so this is the blob-side analogue of {@link waitConverged}.
 */
export async function waitBlobsSettled(
  names: DeviceName[],
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;
  const devices = names.map((n) => device(n));
  const deadline = Date.now() + timeoutMs;
  let settledOnce = false;
  for (;;) {
    const states = await Promise.all(devices.map((d) => d.status()));
    const allSettled = states.every((s) => s.blobs.settled && s.blobs.failed === 0);
    if (allSettled) {
      if (settledOnce) return;
      settledOnce = true;
    } else {
      settledOnce = false;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitBlobsSettled timed out: ${states.map((s) => JSON.stringify(s.blobs)).join(" ")}`,
      );
    }
    await sleep(pollMs);
  }
}

function convergenceDiagnostic(
  names: DeviceName[],
  trees: Map<DeviceName, Tree>,
  pending: Map<DeviceName, number>,
  timeoutMs: number,
): string {
  const lines: string[] = [
    `waitConverged([${names.join(", ")}]) timed out after ${String(timeoutMs)}ms`,
  ];
  for (const name of names) {
    lines.push(`\n── ${name} (pendingDocs=${String(pending.get(name) ?? "?")}) ──`);
    const tree = trees.get(name) ?? {};
    for (const path of Object.keys(tree).sort()) {
      const entry = tree[path];
      if (entry !== undefined) {
        lines.push(`  ${path}  ${entry.sha256.slice(0, 12)}  ${String(entry.size)}B`);
      }
    }
  }
  return lines.join("\n");
}

// ── tree helpers ────────────────────────────────────────────────────────────

/** Structural equality of two `/fs/tree` sha-maps (same paths, same sha256). */
export function treesEqual(a: Tree, b: Tree): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i];
    if (k === undefined || k !== bKeys[i]) return false;
    if (a[k]?.sha256 !== b[k]?.sha256) return false;
  }
  return true;
}

/** Tree equality over PROSE files only (.md/.txt) — proves prose convergence independent of blobs. */
export function proseTreesEqual(a: Tree, b: Tree): boolean {
  const prose = (t: Tree): Tree =>
    Object.fromEntries(Object.entries(t).filter(([k]) => /\.(md|txt)$/.test(k)));
  return treesEqual(prose(a), prose(b));
}

/** Paths in a tree that look like engine-written conflict artifacts. */
export function conflictArtifacts(tree: Tree): string[] {
  return Object.keys(tree)
    .filter((p) => p.includes(" (conflict, "))
    .sort();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── settle-before-flush primitive ────────────────────────────────────────────

/**
 * Poll a device's `/doc` (WITHOUT flushing) until the attached CRDT doc's text contains
 * `expected` — i.e. the engine's vault watcher has INGESTED an external `/fs/edit` into the
 * CRDT before any convergence flush runs.
 *
 * WHY this exists: driving `/sync/flush` (which {@link waitConverged} does every poll)
 * IMMEDIATELY after an external append — before the watcher has ingested it — runs the
 * engine's `materializeLiveDiskContent`, which sees disk AHEAD of the not-yet-ingested doc
 * and writes the STALE doc text back, CLOBBERING the append (the append-vs-flush revert race,
 * documented for the Task-9 hardening pass; see classification-gate.test.ts). Waiting until
 * the doc has ingested the edit is a legitimate "let the external write settle" gate, NOT a
 * workaround that hides behaviour. Bounded; throws on timeout so it never hangs.
 */
export async function waitIngested(
  dev: Device,
  path: string,
  expected: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { text } = await dev.doc(path);
    if (text.includes(expected)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitIngested(${dev.name}, ${path}) timed out after ${String(timeoutMs)}ms ` +
          `waiting for the engine to ingest the disk edit (doc text len=${String(text.length)})`,
      );
    }
    await sleep(500);
  }
}
