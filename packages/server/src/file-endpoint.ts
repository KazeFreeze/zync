/**
 * file-endpoint.ts — HTTP handler for content-addressed blob storage.
 *
 * Routes:
 *   HEAD /blob/:sha256 → 200 (exists) | 404 (absent)
 *   GET  /blob/:sha256 → 200 + bytes  | 404 (absent)
 *   PUT  /blob/:sha256 ← bytes → 201 (stored) | 400 (hash mismatch | bad sha)
 *                                              | 413 (body exceeds maxBodyBytes)
 *
 * Security:
 *   - Auth (Phase 1): when a token is configured, EVERY verb (HEAD/GET/PUT)
 *     requires `Authorization: Bearer <token>`; a missing/wrong token yields 401
 *     (checked BEFORE sha validation or body read, so an unauthorized PUT never
 *     streams a body). When NO token is configured the endpoint is open (the
 *     pre-auth behavior) — used by the in-memory unit tests. M1 uses one static
 *     token shared with the relay; per-device tokens are M4.
 *   - sha256 segment is strictly validated: must be exactly 64 lowercase hex chars.
 *   - PUT hash-on-write: sha256(body) is computed and MUST equal the :sha256 path
 *     segment. Rejects mislabeled or poisoned blobs with 400.
 *   - Body size is capped at maxBodyBytes (default 100 MB) to prevent OOM.
 *     Exceeding the cap yields 413 and destroys the request socket so the OS
 *     reclaims the connection promptly.
 *
 * The blob backend is injectable (BlobBackend) so tests can pass an in-memory
 * Map-based fake and production wires in S3BlobStore.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

/** Default PUT body-size ceiling: 100 MB. Overridable in tests. */
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;

/** Test-only sleep (Node) — used by the GET-latch instrumentation. NOT @zync/core's clock. */
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Mutable GET-latch counters, closed over by ONE handler instance. Only touched when
 * `getDelayMs > 0` (the harness blob-scale gate sets `ZYNC_BLOB_GET_DELAY_MS`); production
 * (delay=0) never allocates a delay and never reads/writes these beyond the unused init.
 */
interface BlobStats {
  /** GETs currently in their delay/serve window (incremented on entry, decremented in finally). */
  activeGets: number;
  /** High-water mark of `activeGets` — the observed concurrent-GET peak (the cap proof). */
  peakGets: number;
  /** Total GETs served since the last reset. */
  getCount: number;
}

// ---------------------------------------------------------------------------
// Injectable backend interface
// ---------------------------------------------------------------------------

export interface BlobBackend {
  has(sha: string): Promise<boolean>;
  put(sha: string, bytes: Uint8Array): Promise<void>;
  /**
   * Retrieve bytes for a known sha.
   * MUST throw an error (any kind) when the key is absent — the handler
   * catches it and replies 404. S3BlobStore already throws NoSuchKey on miss.
   */
  get(sha: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SHA256_RE = /^[a-f0-9]{64}$/;

function isValidSha(sha: string): boolean {
  return SHA256_RE.test(sha);
}

// ---------------------------------------------------------------------------
// Body reading with size cap
// ---------------------------------------------------------------------------

/**
 * Read the entire request body into a Buffer, enforcing a maximum byte limit.
 *
 * When the accumulated body exceeds `maxBytes`:
 *   - Responds with 413 and destroys the socket (so keep-alive doesn't hold it).
 *   - Rejects the returned promise with a sentinel BodyTooLargeError so the
 *     calling handler can return early without writing a second response.
 */
class BodyTooLargeError extends Error {
  constructor() {
    super("request entity too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        if (!res.headersSent) {
          res.writeHead(413);
          res.end();
        }
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err: unknown) => {
      if (!aborted) reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

// ---------------------------------------------------------------------------
// Request handler factory
// ---------------------------------------------------------------------------

export interface BlobHandlerOptions {
  /** Maximum PUT body size in bytes. Defaults to DEFAULT_MAX_BODY_BYTES (100 MB). */
  maxBodyBytes?: number;
  /**
   * Static auth token. When set (non-empty), every verb requires
   * `Authorization: Bearer <token>` (401 otherwise). When omitted, the endpoint
   * is open (pre-auth behavior — used by the in-memory unit tests).
   */
  token?: string;
  /**
   * HARNESS-ONLY GET latch (ms). When > 0, every `GET /blob/:sha` sleeps this long before
   * serving, a concurrent-GET peak is tracked, and an unauthenticated `GET /_blob-stats`
   * diagnostics route is exposed. When 0 (the default — production), the endpoint behaves
   * EXACTLY as before: no delay, no peak tracking, no `/_blob-stats` route, zero overhead.
   * The harness sets it via `ZYNC_BLOB_GET_DELAY_MS` to widen + measure the decoupling window.
   */
  getDelayMs?: number;
}

/**
 * Create a node:http-compatible request handler for the blob endpoint.
 * @param backend — injectable blob storage (in-memory for tests, S3 for prod).
 * @param opts    — optional config (maxBodyBytes, token).
 */
export function createBlobHandler(
  backend: BlobBackend,
  opts: BlobHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const token = opts.token;
  const getDelayMs = opts.getDelayMs ?? 0;
  // One counter set per handler instance, closed over by every request it serves. Untouched
  // when getDelayMs === 0 (production), so the latch + stats are strictly opt-in.
  const stats: BlobStats = { activeGets: 0, peakGets: 0, getCount: 0 };
  return function blobHandler(req: IncomingMessage, res: ServerResponse): void {
    void handleBlobRequest(req, res, backend, maxBodyBytes, token, getDelayMs, stats);
  };
}

async function handleBlobRequest(
  req: IncomingMessage,
  res: ServerResponse,
  backend: BlobBackend,
  maxBodyBytes: number,
  token: string | undefined,
  getDelayMs: number,
  stats: BlobStats,
): Promise<void> {
  try {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // CORS: the Obsidian plugin fetches this endpoint from the `app://obsidian.md` origin — a cross-origin
    // request that, with the Authorization header, triggers a preflight. Send the headers on every response
    // and answer the preflight OPTIONS, which carries NO Authorization and so must bypass the auth gate.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // HARNESS-ONLY diagnostics route (gated behind the GET latch; absent in production where
    // getDelayMs === 0). Matched BEFORE /blob/:sha and WITHOUT auth — it leaks no blob bytes,
    // only the concurrent-GET peak the blob-scale gate reads. `?reset=1` zeroes the window AFTER
    // reading (peak is rebased to the live in-flight count so an active GET is not under-counted).
    if (getDelayMs > 0 && (url === "/_blob-stats" || url.startsWith("/_blob-stats?"))) {
      const body = JSON.stringify({ maxConcurrentGets: stats.peakGets, getCount: stats.getCount });
      if (url.includes("reset=1")) {
        stats.peakGets = stats.activeGets;
        stats.getCount = 0;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Route: /blob/:sha256
    const match = /^\/blob\/([^/?#]+)$/.exec(url);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }

    // Auth gate (when a token is configured): every blob verb requires a matching
    // Bearer. Checked BEFORE sha validation / body read so an unauthorized PUT
    // never streams a body; drain any sent body so the keep-alive socket stays clean.
    if (token !== undefined && token !== "") {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end();
        req.resume();
        return;
      }
    }

    const sha = match[1] ?? "";

    // Strict sha256 validation: must be exactly 64 lowercase hex chars.
    if (!isValidSha(sha)) {
      res.writeHead(400);
      res.end();
      return;
    }

    if (method === "HEAD") {
      // HEAD keeps the has() check — no TOCTOU risk since we never call get().
      const exists = await backend.has(sha);
      res.writeHead(exists ? 200 : 404);
      res.end();
      return;
    }

    if (method === "GET") {
      // Avoid has()-then-get() TOCTOU: call get() directly and catch on miss.
      // BlobBackend.get() MUST throw (any error) when the key is absent.
      if (getDelayMs > 0) {
        // LATCHED path (harness gate only): count this GET, track the concurrent peak, then sleep
        // BEFORE serving so blob draining visibly outlasts prose convergence. `finally` keeps
        // activeGets exact even when the backend throws (a 404 still decrements the in-flight count).
        stats.getCount++;
        stats.activeGets++;
        if (stats.activeGets > stats.peakGets) stats.peakGets = stats.activeGets;
        try {
          await sleep(getDelayMs);
          const bytes = await backend.get(sha);
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.length),
          });
          res.end(bytes);
        } catch {
          if (!res.headersSent) {
            res.writeHead(404);
            res.end();
          }
        } finally {
          stats.activeGets--;
        }
        return;
      }
      try {
        const bytes = await backend.get(sha);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
        });
        res.end(bytes);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    if (method === "PUT") {
      let body: Buffer;
      try {
        body = await readBody(req, res, maxBodyBytes);
      } catch (err) {
        // BodyTooLargeError: 413 already sent and socket destroyed.
        // Any other read error: fall through to the outer catch → 500.
        if (err instanceof BodyTooLargeError) return;
        throw err;
      }

      // Hash-on-write: reject if sha256(body) ≠ path sha.
      const actualSha = createHash("sha256").update(body).digest("hex");
      if (actualSha !== sha) {
        res.writeHead(400);
        res.end();
        return;
      }

      await backend.put(sha, new Uint8Array(body));
      res.writeHead(201);
      res.end();
      return;
    }

    // Unknown method
    res.writeHead(405);
    res.end();
  } catch (err: unknown) {
    // Safety net: a bad request must never crash the process.
    console.error("[zync-blob] unhandled error:", err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}
