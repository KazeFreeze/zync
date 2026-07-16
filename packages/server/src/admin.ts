/**
 * admin.ts — minimal, buildless admin HTTP service for @zync/server.
 *
 * Serves a static admin page (GET /) and a token-management + status JSON API
 * (/api/*) gated behind HTTP Basic auth (username + password). Backed by the
 * same TokenRegistry the relay + blob endpoint read, so add/revoke take effect
 * via the registry's hot-reload. Bound to the tailnet interface by the compose;
 * never exposed publicly. No CORS (same-origin page).
 *
 * Architecture overview
 * ─────────────────────
 *   GET /                    → static UI (behind Basic auth, like every route)
 *   GET  /api/status         → { uptimeSec, deviceCount, blobStoreOk, snapshotCount }
 *   GET  /api/tokens         → DeviceTokenPublic[] (tokenMasked, no raw token)
 *   POST /api/tokens         → { device: string } → DeviceToken (returns raw token once)
 *   DELETE /api/tokens/:id   → { removed: boolean }
 *
 * EVERY request (incl. GET /) requires HTTP Basic auth — ZYNC_ADMIN_USER /
 * ZYNC_ADMIN_PASSWORD, compared with timingSafeEqual. Missing/wrong creds → 401
 * + `WWW-Authenticate: Basic` so the browser prompts for login.
 *
 * buildStatusProvider() wires the live runtime pieces (registry + blob backend +
 * snapshot dir) into an AdminStatusProvider callable that createAdminHandler
 * accepts. Tests supply a stub provider to keep the handler unit-testable.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { TokenRegistry } from "./token-registry.js";
import type { BlobBackend } from "./file-endpoint.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Snapshot of server health returned by GET /api/status. */
export interface AdminStatus {
  /** Whole seconds since the process started. */
  uptimeSec: number;
  /** Number of registered device tokens (file-mode only; 0 in single-token mode). */
  deviceCount: number;
  /** Whether the blob store responded without error to a sentinel probe. */
  blobStoreOk: boolean;
  /** Number of *.bin snapshot files in the configured snapshot directory. */
  snapshotCount: number;
}

/**
 * Async supplier for AdminStatus. Injected into createAdminHandler so that
 * tests can supply a deterministic stub without touching the file system or
 * a real blob store.
 */
export type AdminStatusProvider = () => Promise<AdminStatus>;

/** Options for createAdminHandler(). */
export interface AdminHandlerOptions {
  /** Live TokenRegistry shared with the relay and blob handlers. */
  registry: TokenRegistry;
  /** Admin username for HTTP Basic auth. */
  adminUser: string;
  /** Admin password for HTTP Basic auth. */
  adminPassword: string;
  /** Status supplier wired to live runtime pieces in production. */
  status: AdminStatusProvider;
  /**
   * Contents of admin-ui.html, injected here so the handler is fully testable
   * without touching the filesystem at request time.
   */
  uiHtml: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Thrown by readJsonBody when the request body exceeds the byte cap. */
class BodyTooLargeError extends Error {}
/** Thrown by readJsonBody when the request body is not valid JSON. */
class BadJsonError extends Error {}

/**
 * Constant-time comparison of the presented token against the admin token.
 * timingSafeEqual throws on length mismatch, so we guard length first.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // length mismatch can't be constant-time; return false (the admin token is
    // a 64-hex random secret, so a length oracle is not exploitable here).
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Validate an HTTP Basic `Authorization` header against the admin credentials.
 * Both user and password are evaluated (no early return) so neither leaks via
 * comparison timing.
 */
function checkBasicAuth(authHeader: string | undefined, user: string, password: string): boolean {
  if (!authHeader?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const okUser = safeEqual(decoded.slice(0, idx), user);
  const okPass = safeEqual(decoded.slice(idx + 1), password);
  return okUser && okPass;
}

/** Serialise `body` as JSON and end the response. */
function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(s);
}

/**
 * Drain the request body (capped at `maxBytes`) and parse it as JSON.
 * Returns {} for empty bodies. Throws BodyTooLargeError past the cap and
 * BadJsonError on a parse failure — the POST route maps these to 413/400.
 * Default cap is generous: the only body we accept is `{ "device": "..." }`.
 */
async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadJsonError();
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Build a Node `http.RequestListener` that implements the admin API.
 *
 * The returned handler is suitable for `http.createServer(handler)`. Wire it
 * to its own port via `index.ts` (Task 6) so it can be bound exclusively to
 * the tailnet interface.
 */
export function createAdminHandler(
  opts: AdminHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { registry, adminUser, adminPassword, status, uiHtml } = opts;

  return function adminHandler(req: IncomingMessage, res: ServerResponse): void {
    void handle(req, res).catch((err: unknown) => {
      console.error("[zync-admin] unhandled error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // ── HTTP Basic auth gate — covers EVERY route, including GET / ───────────
    if (!checkBasicAuth(req.headers.authorization, adminUser, adminPassword)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Zync Admin", charset="UTF-8"' });
      res.end();
      return;
    }

    // ── Static UI ────────────────────────────────────────────────────────────
    if (method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(uiHtml);
      return;
    }

    // ── Everything else must be under /api/ ──────────────────────────────────
    if (!url.startsWith("/api/")) {
      res.writeHead(404);
      res.end();
      return;
    }

    // ── GET /api/status ──────────────────────────────────────────────────────
    if (method === "GET" && url === "/api/status") {
      json(res, 200, await status());
      return;
    }

    // ── GET /api/tokens ──────────────────────────────────────────────────────
    if (method === "GET" && url === "/api/tokens") {
      json(res, 200, registry.list());
      return;
    }

    // ── POST /api/tokens ─────────────────────────────────────────────────────
    if (method === "POST" && url === "/api/tokens") {
      let body: { device?: unknown };
      try {
        body = (await readJsonBody(req)) as { device?: unknown };
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          json(res, 413, { error: "request body too large" });
          req.destroy(); // stop reading the oversized body (mirrors file-endpoint.ts)
          return;
        }
        if (err instanceof BadJsonError) {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        throw err;
      }
      const device = typeof body.device === "string" ? body.device.trim() : "";
      if (!device) {
        json(res, 400, { error: "device (non-empty string) required" });
        return;
      }
      // Returns the full DeviceToken including the raw token — the only time
      // the caller ever sees it. Subsequent list() calls return tokenMasked.
      json(res, 200, registry.add(device));
      return;
    }

    // ── DELETE /api/tokens/:id ───────────────────────────────────────────────
    const delMatch = /^\/api\/tokens\/([^/?#]+)$/.exec(url);
    if (method === "DELETE" && delMatch) {
      const id = decodeURIComponent(delMatch[1] ?? "");
      const removed = registry.remove(id);
      json(res, removed ? 200 : 404, { removed });
      return;
    }

    // ── Catch-all ────────────────────────────────────────────────────────────
    // Catch-all: unknown routes AND unknown methods on known paths return 404
    // (deliberate — do not advertise which routes/methods exist on the admin surface).
    res.writeHead(404);
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Status provider factory
// ---------------------------------------------------------------------------

/**
 * Wire the live runtime pieces into an AdminStatusProvider.
 *
 * - `blobStoreOk`: probes `blobBackend.has()` with a sentinel SHA-256 key.
 *   Any thrown error (network, auth, etc.) maps to `false`; the has() return
 *   value itself is not used because the sentinel key is intentionally absent.
 * - `snapshotCount`: counts `*.bin` files in `snapshotDir` (ENOENT → 0).
 * - `uptimeSec`: `Math.floor((now() - startedAt) / 1000)`, clamped to ≥ 0.
 *
 * @param opts.registry   - Shared TokenRegistry for deviceCount.
 * @param opts.blobBackend - Blob backend to probe for liveness.
 * @param opts.snapshotDir - Directory holding snapshot *.bin files.
 * @param opts.startedAt  - `Date.now()` value captured at process start.
 * @param opts.now        - Injectable clock (milliseconds); defaults to Date.now.
 */
export function buildStatusProvider(opts: {
  registry: TokenRegistry;
  blobBackend: BlobBackend;
  snapshotDir: string;
  startedAt: number;
  now?: () => number;
}): AdminStatusProvider {
  const now = opts.now ?? (() => Date.now());

  return async (): Promise<AdminStatus> => {
    // Blob store liveness probe — sentinel key is intentionally absent.
    let blobStoreOk = false;
    try {
      await opts.blobBackend.has("0".repeat(64));
      blobStoreOk = true;
    } catch {
      blobStoreOk = false;
    }

    // Count *.bin snapshot files; treat missing directory as zero.
    let snapshotCount = 0;
    try {
      const files = await fsp.readdir(opts.snapshotDir);
      snapshotCount = files.filter((f) => path.extname(f) === ".bin").length;
    } catch {
      snapshotCount = 0;
    }

    return {
      uptimeSec: Math.max(0, Math.floor((now() - opts.startedAt) / 1000)),
      deviceCount: opts.registry.deviceCount,
      blobStoreOk,
      snapshotCount,
    };
  };
}
