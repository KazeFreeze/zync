/**
 * Control API (0b-3 Task 1b) — a `node:http` request handler the test harness drives
 * to run sync scenarios against a single in-process {@link SyncEngine}.
 *
 * The handler operates on the engine + adapters + a small {@link DaemonState} bag of
 * observability counters. It is deliberately framework-free (no Express): a tiny JSON
 * router over `node:http`. {@link createControlApi} returns a handler so tests can mount
 * it on an ephemeral port (or call its routing directly) without booting `daemon.ts`.
 *
 * ENDPOINT SEMANTICS — the load-bearing distinction (see daemon.ts for the why):
 * - `/fs/write`, `/fs/edit`, `/fs/delete` mutate disk DIRECTLY (node:fs) so the vault
 *   WATCHER detects the change → the engine ingests it. This simulates an EXTERNAL
 *   writer (Claude/Templater/a formatter), the whole point of the harness.
 * - `/fs/rename` is ENGINE-MEDIATED (`vault.rename`) because the NodeFsVault rename
 *   emits a synchronous, deterministic rename event the engine consumes for docId
 *   continuity.
 */

import * as http from "node:http";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ConfigPort,
  CommunityPluginsPort,
  CrdtDoc,
  TransportPort,
  VaultPath,
} from "@zync/core";
import { SyncEngine, sha256OfText, sha256OfBytes } from "@zync/core";
import { SimulatedEditor } from "@zync/core/testing";
import type { NodeFsVault } from "./adapters/node-fs-vault.js";
import type { FsEngineStateStore } from "./adapters/fs-engine-state.js";

/**
 * Mutable observability bag the daemon maintains and the control API reads. The
 * counters are the convergence/observability signals scenario assertions read:
 * - `ingestCount`: count of external file-change watcher events the engine ingested;
 *   always 0 in projector (ingestDisabled) mode. NOT counted for delete/rename (those
 *   are tracked separately if ever needed).
 * - `writeCount`: number of `/fs/write` + `/fs/edit` mutations THIS daemon performed
 *   (external-writer simulation count).
 * - `lastSyncAt`: epoch-ms of the last time the transport status became "connected",
 *   or `null` if it never has (e.g. offline in-process tests).
 * - `editors`: live {@link SimulatedEditor} panes keyed by `${path}::${paneId}`.
 */
export interface DaemonState {
  /**
   * Count of external file-change watcher events the engine ingested; always 0 in
   * projector (ingestDisabled) mode — the engine's onWrite early-returns, so no ingest
   * happens and this counter must accurately reflect that.
   */
  ingestCount: number;
  writeCount: number;
  lastSyncAt: number | null;
  readonly editors: Map<string, SimulatedEditor>;
}

/** Everything the control API needs to serve requests. */
export interface ControlApiDeps {
  engine: SyncEngine;
  /** The transport — read directly for `/status` `conn` (not exposed via the engine). */
  transport: TransportPort;
  vault: NodeFsVault;
  /** ConfigPort for the config zone (.obsidian/themes, .obsidian/snippets). */
  config: ConfigPort;
  /** CommunityPluginsPort for reading community-plugins.json (Slice 2b). */
  communityPlugins?: CommunityPluginsPort;
  /** Absolute path to the vault root (for direct external fs writes). */
  vaultDir: string;
  /** Absolute path to the FsDocStore directory (for /metrics docStoreBytes). */
  docStoreDir: string;
  /** Absolute path to the fixtures root (default /fixtures). */
  fixturesDir: string;
  state: DaemonState;
  /** True once `engine.start()` has been called (gates fixture loading). */
  isStarted: () => boolean;
  setStarted: (v: boolean) => void;
  /**
   * The durable engine-state store. Exposed so the control API can invoke
   * operator/test helpers such as {@link FsEngineStateStore.clearAllSyncedStamps}
   * that are not part of the {@link EngineStateStore} port interface.
   */
  engineState: FsEngineStateStore;
}

const vp = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

interface JsonResponse {
  status: number;
  body: unknown;
}

/** A typed error carrying an HTTP status so route handlers can reject cleanly. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Build the `node:http` request handler. Pure routing over {@link ControlApiDeps};
 * `daemon.ts` wraps the returned handler in a server and `listen`s.
 */
export function createControlApi(deps: ControlApiDeps): http.RequestListener {
  return (req, res) => {
    void handle(deps, req)
      .then((out) => {
        sendJson(res, out.status, out.body);
      })
      .catch((err: unknown) => {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { ok: false, error: err.message });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { ok: false, error: message });
        }
      });
  };
}

async function handle(deps: ControlApiDeps, req: http.IncomingMessage): Promise<JsonResponse> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${method} ${url.pathname}`;

  switch (route) {
    case "POST /vault/load":
      return vaultLoad(deps, await readJson(req));
    case "POST /sync/start":
      return syncStart(deps);
    case "POST /sync/stop":
      return syncStop(deps);
    case "POST /sync/flush":
      return syncFlush(deps);
    case "POST /fs/write":
      return fsWrite(deps, await readJson(req));
    case "POST /fs/edit":
      return fsEdit(deps, await readJson(req));
    case "POST /fs/rename":
      return fsRename(deps, await readJson(req));
    case "POST /fs/delete":
      return fsDelete(deps, await readJson(req));
    case "POST /inbox/resolve-content":
      return inboxResolveContent(deps, await readJson(req));
    case "POST /config/write":
      return configWrite(deps, await readJson(req));
    case "POST /config/remove":
      return configRemove(deps, await readJson(req));
    case "POST /config/resolve":
      return configResolve(deps, await readJson(req));
    case "POST /config/rescan":
      return configRescan(deps);
    case "GET /config/list":
      return configList(deps);
    case "POST /plugins/opt-in":
      return pluginOptIn(deps, await readJson(req));
    case "GET /plugins/list":
      return pluginList(deps);
    case "POST /plugins/enabled":
      return pluginEnabled(deps, await readJson(req));
    case "POST /plugins/suppress":
      return pluginSuppress(deps, await readJson(req));
    case "GET /plugins/community-list":
      return pluginCommunityList(deps);
    case "POST /plugins/community-write":
      return pluginCommunityWrite(deps, await readJson(req));
    case "POST /plugins/data":
      return pluginDataWrite(deps, await readJson(req));
    case "GET /plugins/data":
      return pluginDataRead(deps, url);
    case "POST /plugins/settings-sync":
      return pluginSettingsSync(deps, await readJson(req));
    case "GET /fs/read":
      return fsRead(deps, url);
    case "GET /fs/tree":
      return fsTree(deps);
    case "GET /status":
      return status(deps);
    case "GET /doc":
      return doc(deps, url);
    case "POST /editor/open":
      return editorOpen(deps, await readJson(req));
    case "POST /editor/type":
      return editorType(deps, await readJson(req));
    case "POST /editor/close":
      return editorClose(deps, await readJson(req));
    case "GET /metrics":
      return metrics(deps);
    case "POST /engine/clear-synced-stamps":
      return engineClearSyncedStamps(deps);
    default:
      throw new HttpError(404, `no route: ${route}`);
  }
}

// ── /vault/load ─────────────────────────────────────────────────────────────

interface VaultLoadBody {
  fixture: string;
  variant?: string;
}

/**
 * Recursively copy `<fixturesDir>/<fixture>[/<variant>]` into the vault dir. Only
 * valid BEFORE `/sync/start` (the boot-idle contract — the engine bootstraps the
 * loaded files at start). Returns the count of files copied.
 */
async function vaultLoad(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  if (deps.isStarted()) {
    throw new HttpError(409, "/vault/load is only valid before /sync/start");
  }
  const body = raw as VaultLoadBody;
  if (typeof body.fixture !== "string") throw new HttpError(400, "fixture is required");

  const segments = [deps.fixturesDir, body.fixture];
  if (typeof body.variant === "string") segments.push(body.variant);
  const src = path.join(...segments);

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(src);
  } catch {
    throw new HttpError(404, `fixture not found: ${src}`);
  }
  if (!stat.isDirectory()) throw new HttpError(400, `fixture is not a directory: ${src}`);

  const fileCount = await copyDir(src, deps.vaultDir);
  return { status: 200, body: { ok: true, fileCount } };
}

/** Recursive copy; returns the number of FILES copied. */
async function copyDir(srcDir: string, destDir: string): Promise<number> {
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
      count += 1;
    }
  }
  return count;
}

// ── /sync/* ───────────────────────────────────────────────────────────────────

async function syncStart(deps: ControlApiDeps): Promise<JsonResponse> {
  if (!deps.isStarted()) {
    await deps.engine.start();
    deps.setStarted(true);
  }
  return { status: 200, body: { ok: true } };
}

async function syncStop(deps: ControlApiDeps): Promise<JsonResponse> {
  if (deps.isStarted()) {
    await deps.engine.stop();
    deps.setStarted(false);
  }
  return { status: 200, body: { ok: true } };
}

/**
 * Drive the engine toward quiescence and report whether it settled. While CONNECTED
 * we run the bounded catch-up loop (`engine.waitConverged()` = loop
 * `whenIdle → runCatchUp → structuralReconcile` until `pendingDocs` empties); offline
 * or pre-start we only drain in-flight work (`whenIdle`) since catch-up no-ops while
 * disconnected and unpushed local edits would (correctly) keep it from settling.
 *
 * `waitConverged` THROWS if it cannot settle within its bound — we CATCH that and
 * return `{ ok: true, converged: false }` (a 200) rather than a 500, so the harness
 * poll treats "didn't settle this round" as a signal to keep polling, not an error.
 * The remaining `pendingDocs` is reported for diagnostics.
 *
 * PROSE-ONLY: flush converges DOC (prose) state only. The blob-fetch decouple removed
 * blobs from `waitConverged`, so background blob materialization is NOT awaited here —
 * observe it separately via `GET /status` `blobs.settled`.
 */
async function syncFlush(deps: ControlApiDeps): Promise<JsonResponse> {
  let converged = true;
  if (deps.isStarted() && deps.transport.status() === "connected") {
    try {
      await deps.engine.waitConverged();
    } catch {
      converged = false;
    }
  } else {
    await deps.engine.whenIdle();
  }
  const pendingDocs = deps.isStarted() ? (await deps.engine.pendingDocs()).length : 0;
  return { status: 200, body: { ok: true, converged, pendingDocs } };
}

// ── /fs/* ───────────────────────────────────────────────────────────────────

interface FsWriteBody {
  path: string;
  contentBase64: string;
}

/**
 * EXTERNAL writer: write bytes to disk DIRECTLY via node:fs (NOT engine-mediated) so
 * the vault WATCHER detects it → the engine ingests. Counts toward `writeCount`.
 */
async function fsWrite(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const body = raw as FsWriteBody;
  if (typeof body.path !== "string" || typeof body.contentBase64 !== "string") {
    throw new HttpError(400, "path and contentBase64 are required");
  }
  const bytes = new Uint8Array(Buffer.from(body.contentBase64, "base64"));
  await externalWrite(deps, body.path, bytes);
  deps.state.writeCount += 1;
  return { status: 200, body: { ok: true } };
}

interface FsEditBody {
  path: string;
  find?: string;
  replace?: string;
  append?: string;
}

/**
 * EXTERNAL editor: read disk, apply a find/replace or append, write back externally
 * (same path as /fs/write — the watcher sees it). Counts toward `writeCount`.
 */
async function fsEdit(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const body = raw as FsEditBody;
  if (typeof body.path !== "string") throw new HttpError(400, "path is required");

  const abs = absInVault(deps, body.path);
  let current: string;
  try {
    current = await fsp.readFile(abs, "utf8");
  } catch {
    throw new HttpError(404, `file not found: ${body.path}`);
  }

  let next: string;
  if (typeof body.append === "string") {
    next = current + body.append;
  } else if (typeof body.find === "string" && typeof body.replace === "string") {
    next = current.replace(body.find, body.replace);
  } else {
    throw new HttpError(400, "provide {find, replace} or {append}");
  }

  await externalWrite(deps, body.path, utf8(next));
  deps.state.writeCount += 1;
  return { status: 200, body: { ok: true } };
}

interface FsRenameBody {
  from: string;
  to: string;
}

/**
 * ENGINE-MEDIATED rename: call the NodeFsVault `rename` (which emits a real rename
 * event), giving the engine docId continuity across the move.
 */
async function fsRename(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const body = raw as FsRenameBody;
  if (typeof body.from !== "string" || typeof body.to !== "string") {
    throw new HttpError(400, "from and to are required");
  }
  const renamed = await deps.engine.requestRename(vp(body.from), vp(body.to));
  return { status: 200, body: { ok: true, renamed } };
}

interface FsDeleteBody {
  path: string;
}

/**
 * Delete a vault file via `vault.remove`, which unlinks it AND emits a synthetic `delete`
 * event SYNCHRONOUSLY — so the engine DETERMINISTICALLY observes the deletion (lays the
 * tombstone) before any subsequent `/sync/flush` runs. Previously this used a raw
 * `fsp.rm` and relied solely on the ASYNC, occasionally-LOSSY recursive `fs.watch`: under
 * an event burst (e.g. right after a rename) the watcher could drop the unlink or probe it
 * as a `modify`, so a flush-driven `materializeLiveDiskContent` RE-CREATED the file before
 * the delete was ever ingested — the file came back and the deletion silently vanished.
 * `vault.remove`'s synthetic event closes that race; the real watcher delete, if it still
 * arrives, is an idempotent no-op (the entry is already tombstoned).
 */
async function fsDelete(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const body = raw as FsDeleteBody;
  if (typeof body.path !== "string") throw new HttpError(400, "path is required");
  await deps.vault.remove(vp(body.path));
  return { status: 200, body: { ok: true } };
}

interface InboxResolveContentBody {
  id: string;
  action: "keep-current" | "keep-backup";
}

async function inboxResolveContent(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const { id, action } = raw as InboxResolveContentBody;
  await deps.engine.resolveContentConflict(id, action);
  return { status: 200, body: { ok: true } };
}

// ── /config/* ─────────────────────────────────────────────────────────────────

interface ConfigWriteBody {
  path: string;
  contentBase64: string;
}

/**
 * Write bytes to the config zone via the ConfigPort (NOT a raw fs write) so the engine's
 * watcher observes and ingests the change through the config channel.
 */
async function configWrite(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const body = raw as ConfigWriteBody;
  if (typeof body.path !== "string" || typeof body.contentBase64 !== "string") {
    throw new HttpError(400, "path and contentBase64 are required");
  }
  const bytes = new Uint8Array(Buffer.from(body.contentBase64, "base64"));
  await deps.config.writeAtomic(vp(body.path), bytes);
  return { status: 200, body: { ok: true } };
}

interface ConfigRemoveBody {
  path: string;
}

async function configRemove(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const body = raw as ConfigRemoveBody;
  if (typeof body.path !== "string") {
    throw new HttpError(400, "path is required");
  }
  await deps.config.remove(vp(body.path));
  return { status: 200, body: { ok: true } };
}

async function configList(deps: ControlApiDeps): Promise<JsonResponse> {
  const files = await deps.config.list();
  return { status: 200, body: { files } };
}

interface ConfigResolveBody {
  id: string;
  action: "keep-mine" | "keep-theirs";
}

async function configResolve(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const body = raw as ConfigResolveBody;
  if (typeof body.id !== "string" || typeof body.action !== "string") {
    throw new HttpError(400, "id and action are required");
  }
  await deps.engine.resolveConfigConflict(body.id, body.action);
  return { status: 200, body: { ok: true } };
}

async function configRescan(deps: ControlApiDeps): Promise<JsonResponse> {
  await deps.config.rescan();
  return { status: 200, body: { ok: true } };
}

// ── /plugins/* ────────────────────────────────────────────────────────────────

async function pluginOptIn(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const body = raw as { id?: string; optIn?: boolean };
  if (typeof body.id !== "string" || typeof body.optIn !== "boolean")
    throw new HttpError(400, "id and optIn are required");
  await deps.engine.setPluginOptIn(body.id, body.optIn);
  return { status: 200, body: { ok: true } };
}

function pluginList(deps: ControlApiDeps): JsonResponse {
  return { status: 200, body: { plugins: deps.engine.listPluginOptIn() } };
}

function pluginEnabled(deps: ControlApiDeps, raw: unknown): JsonResponse {
  const b = raw as { id?: string; enabled?: boolean };
  if (typeof b.id !== "string" || typeof b.enabled !== "boolean")
    throw new HttpError(400, "id and enabled required");
  deps.engine.setPluginEnabled(b.id, b.enabled);
  return { status: 200, body: { ok: true } };
}

async function pluginSuppress(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const b = raw as { id?: string; suppressed?: boolean };
  if (typeof b.id !== "string" || typeof b.suppressed !== "boolean")
    throw new HttpError(400, "id and suppressed required");
  await deps.engine.setPluginSuppressed(b.id, b.suppressed);
  return { status: 200, body: { ok: true } };
}

async function pluginCommunityList(deps: ControlApiDeps): Promise<JsonResponse> {
  return { status: 200, body: { enabled: (await deps.communityPlugins?.read()) ?? [] } };
}

async function pluginCommunityWrite(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const b = raw as { ids?: unknown };
  if (!Array.isArray(b.ids) || !b.ids.every((x): x is string => typeof x === "string")) {
    throw new HttpError(400, "ids must be an array of strings");
  }
  await deps.communityPlugins?.writeAtomic(b.ids);
  return { status: 200, body: { ok: true } };
}

async function pluginDataWrite(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  const b = raw as { id?: unknown; json?: unknown };
  if (typeof b.id !== "string") throw new HttpError(400, "id is required");
  if (b.json === undefined) throw new HttpError(400, "json is required");
  const bytes = new TextEncoder().encode(JSON.stringify(b.json));
  await deps.engine.writePluginData(b.id, bytes);
  return { status: 200, body: { ok: true } };
}

async function pluginDataRead(deps: ControlApiDeps, url: URL): Promise<JsonResponse> {
  const id = url.searchParams.get("id");
  if (id === null) throw new HttpError(400, "id query param is required");
  const bytes = await deps.engine.readPluginData(id);
  if (bytes === null) return { status: 200, body: { json: null } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpError(500, `data.json for ${id} is not valid JSON`);
  }
  return { status: 200, body: { json: parsed } };
}

function pluginSettingsSync(deps: ControlApiDeps, raw: unknown): JsonResponse {
  const b = raw as { id?: unknown; on?: unknown };
  if (typeof b.id !== "string") throw new HttpError(400, "id is required");
  if (typeof b.on !== "boolean") throw new HttpError(400, "on is required");
  deps.engine.setPluginSettingsSync(b.id, b.on);
  return { status: 200, body: { ok: true } };
}

async function fsRead(deps: ControlApiDeps, url: URL): Promise<JsonResponse> {
  const p = url.searchParams.get("path");
  if (p === null) throw new HttpError(400, "path query param is required");
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(absInVault(deps, p));
  } catch {
    throw new HttpError(404, `file not found: ${p}`);
  }
  return { status: 200, body: { contentBase64: bytes.toString("base64") } };
}

/**
 * The convergence-assertion surface: every vault file (EXCLUDING `.obsidian/zync/**`,
 * which the adapter's `list()` already filters) → its content sha256 + size.
 */
async function fsTree(deps: ControlApiDeps): Promise<JsonResponse> {
  const tree: Record<string, { sha256: string; size: number }> = {};
  for (const { path: p, size } of await deps.vault.list()) {
    const bytes = await deps.vault.read(p);
    if (bytes === null) continue;
    tree[p] = { sha256: await sha256OfBytes(bytes), size };
  }
  return { status: 200, body: tree };
}

// ── /status ───────────────────────────────────────────────────────────────────

async function status(deps: ControlApiDeps): Promise<JsonResponse> {
  const { engine, state } = deps;
  const pending = deps.isStarted() ? (await engine.pendingDocs()).length : 0;
  // Inbox is only constructed after start(); guard so /status works boot-idle.
  const conflicts = deps.isStarted() ? engine.inbox.list() : [];
  return {
    status: 200,
    body: {
      conn: deps.transport.status(),
      pendingDocs: pending,
      conflicts,
      writeCount: state.writeCount,
      ingestCount: state.ingestCount,
      lastSyncAt: state.lastSyncAt,
      blobs: deps.isStarted()
        ? { ...engine.blobProgress(), settled: engine.blobsSettled() }
        : { materialized: 0, total: 0, failed: 0, settled: true },
    },
  };
}

// ── /doc ───────────────────────────────────────────────────────────────────────

async function doc(deps: ControlApiDeps, url: URL): Promise<JsonResponse> {
  const p = url.searchParams.get("path");
  if (p === null) throw new HttpError(400, "path query param is required");
  const path0 = vp(p);

  const entry = deps.isStarted() ? deps.engine.index.get(path0) : undefined;
  const diskBytes = await deps.vault.read(path0);
  if (entry === undefined && diskBytes === null) {
    throw new HttpError(404, `no doc and no file at ${p}`);
  }

  const docId = entry?.docId ?? null;
  // LIVE-vs-TOMBSTONE diagnostic (0b-3 rename transaction): `/doc?path=` previously proved
  // only that an index ENTRY exists, not that it is LIVE — so a TOMBSTONED entry (e.g. a
  // rename's old key, or a renamed entry wrongly tombstoned by un-quarantined watcher
  // fallout) returned a continuous docId, masking a dead entry as a healthy one. Surface
  // `deleted` (the raw flag) and `live` (entry exists AND not tombstoned) so the harness can
  // distinguish a true live rename from a tombstoned one. `null` when there is no entry
  // (disk-only file).
  const deleted = entry === undefined ? null : entry.deleted === true;
  const live = entry !== undefined && entry.deleted !== true;
  const attached = deps.isStarted() ? deps.engine.getAttachedDoc(path0) : undefined;
  const text = attached?.getText() ?? (diskBytes !== null ? decode(diskBytes) : "");
  const contentSha256 = await sha256OfText(text);
  const baseHash =
    docId !== null && deps.isStarted()
      ? ((await deps.engine.base.load(docId))?.fileHash ?? null)
      : null;
  const fsmState = deps.isStarted() ? deps.engine.getAuthority(path0).state : "inactive";

  return {
    status: 200,
    body: { docId, deleted, live, text, contentSha256, baseHash, fsmState },
  };
}

// ── /editor/* ───────────────────────────────────────────────────────────────────

interface EditorOpenBody {
  path: string;
  paneId?: string;
}

/**
 * Bind an editor pane: authority.bindEditor → `active-bound`, then drive the lazy
 * attach for the now-open note (bind FIRST is REQUIRED — see
 * {@link SyncEngine.ensureNoteAttached}). Store a {@link SimulatedEditor} on the
 * canonical attached doc + authority keyed by `${path}::${paneId}`.
 */
async function editorOpen(deps: ControlApiDeps, raw: unknown): Promise<JsonResponse> {
  requireStarted(deps);
  const body = raw as EditorOpenBody;
  if (typeof body.path !== "string") throw new HttpError(400, "path is required");
  const paneId = body.paneId ?? "pane-1";
  const path0 = vp(body.path);

  const authority = deps.engine.getAuthority(path0);
  authority.bindEditor(paneId);
  const attached: CrdtDoc | undefined = await deps.engine.ensureNoteAttached(path0);
  if (attached !== undefined) {
    deps.state.editors.set(
      editorKey(body.path, paneId),
      new SimulatedEditor(attached, authority, paneId),
    );
  }
  return { status: 200, body: { ok: true, fsmState: authority.state } };
}

interface EditorTypeBody {
  path: string;
  paneId?: string;
  at: number;
  text?: string;
  del?: number;
  ins?: string;
}

/** Type or replaceRange on the stored SimulatedEditor. */
function editorType(deps: ControlApiDeps, raw: unknown): JsonResponse {
  requireStarted(deps);
  const body = raw as EditorTypeBody;
  if (typeof body.path !== "string") throw new HttpError(400, "path is required");
  if (typeof body.at !== "number") throw new HttpError(400, "at is required");
  const paneId = body.paneId ?? "pane-1";

  const editor = deps.state.editors.get(editorKey(body.path, paneId));
  if (editor === undefined) throw new HttpError(404, `no open editor for ${body.path}::${paneId}`);

  if (typeof body.text === "string") {
    editor.type(body.at, body.text);
  } else if (typeof body.del === "number" && typeof body.ins === "string") {
    editor.replaceRange(body.at, body.del, body.ins);
  } else {
    throw new HttpError(400, "provide {at, text} or {at, del, ins}");
  }
  return { status: 200, body: { ok: true } };
}

interface EditorCloseBody {
  path: string;
  paneId?: string;
}

/** Close the pane (unbind authority) and drop the stored editor. */
function editorClose(deps: ControlApiDeps, raw: unknown): JsonResponse {
  requireStarted(deps);
  const body = raw as EditorCloseBody;
  if (typeof body.path !== "string") throw new HttpError(400, "path is required");
  const paneId = body.paneId ?? "pane-1";
  const key = editorKey(body.path, paneId);

  const editor = deps.state.editors.get(key);
  if (editor !== undefined) {
    editor.close();
    deps.state.editors.delete(key);
  }
  const fsmState = deps.engine.getAuthority(vp(body.path)).state;
  return { status: 200, body: { ok: true, fsmState } };
}

// ── /metrics ───────────────────────────────────────────────────────────────────

async function metrics(deps: ControlApiDeps): Promise<JsonResponse> {
  const MiB = 1024 * 1024;
  const rssMb = process.memoryUsage().rss / MiB;
  const docStoreBytes = await dirBytes(deps.docStoreDir);
  const indexDocBytes = deps.isStarted() ? deps.engine.indexSnapshotBytes() : 0;
  const attachedDocs = deps.isStarted() ? deps.engine.attachedDocCount() : 0;
  return {
    status: 200,
    body: { rssMb, docStoreBytes, indexDocBytes, attachedDocs },
  };
}

/** Sum of file sizes directly inside `dir` (flat — the FsDocStore layout). */
async function dirBytes(dir: string): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const st = await fsp.stat(path.join(dir, entry.name));
    total += st.size;
  }
  return total;
}

// ── /engine/* ─────────────────────────────────────────────────────────────────

/**
 * Clear ALL persisted synced stamps and atomically rewrite the state file so the
 * cleared state SURVIVES a daemon restart. Callable whether the engine is running
 * OR stopped (the control API stays up while the engine is stopped). When called
 * with the engine stopped — the intended test usage — the next `POST /sync/start`
 * loads from the persisted file and sees no synced stamps, so every live doc is
 * re-pending and the startup self-heal drains them back to zero over the relay.
 */
async function engineClearSyncedStamps(deps: ControlApiDeps): Promise<JsonResponse> {
  await deps.engineState.clearAllSyncedStamps();
  return { status: 200, body: { ok: true } };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function editorKey(p: string, paneId: string): string {
  return `${p}::${paneId}`;
}

function requireStarted(deps: ControlApiDeps): void {
  if (!deps.isStarted()) throw new HttpError(409, "engine not started (POST /sync/start first)");
}

/** Resolve a vault-relative path to an absolute path, guarding against escape. */
function absInVault(deps: ControlApiDeps, rel: string): string {
  const joined = path.join(deps.vaultDir, rel);
  if (!joined.startsWith(deps.vaultDir + path.sep) && joined !== deps.vaultDir) {
    throw new HttpError(400, `path escapes vault: ${rel}`);
  }
  return joined;
}

/** Write bytes to disk directly (external-writer simulation), creating parent dirs. */
async function externalWrite(deps: ControlApiDeps, rel: string, bytes: Uint8Array): Promise<void> {
  const abs = absInVault(deps, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, bytes);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function sendJson(res: http.ServerResponse, status0: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status0, { "Content-Type": "application/json" });
  res.end(payload);
}

export { HttpError };
