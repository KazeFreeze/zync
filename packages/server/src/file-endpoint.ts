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
 *   - sha256 segment is strictly validated: must be exactly 64 lowercase hex chars.
 *   - PUT hash-on-write: sha256(body) is computed and MUST equal the :sha256 path
 *     segment. Rejects mislabeled or poisoned blobs with 400.
 *   - Body size is capped at maxBodyBytes (default 100 MB) to prevent OOM on an
 *     unauthenticated endpoint. Exceeding the cap yields 413 and destroys the
 *     request socket so the OS reclaims the connection promptly.
 *
 * The blob backend is injectable (BlobBackend) so tests can pass an in-memory
 * Map-based fake and production wires in S3BlobStore.
 *
 * Auth: blob endpoint auth is DEFERRED to Phase 1. The current HttpBlobStore
 * client sends no Authorization header, so no auth is applied here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

/** Default PUT body-size ceiling: 100 MB. Overridable in tests. */
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;

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
}

/**
 * Create a node:http-compatible request handler for the blob endpoint.
 * @param backend — injectable blob storage (in-memory for tests, S3 for prod).
 * @param opts    — optional config (maxBodyBytes for tests that need a low cap).
 */
export function createBlobHandler(
  backend: BlobBackend,
  opts: BlobHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return function blobHandler(req: IncomingMessage, res: ServerResponse): void {
    void handleBlobRequest(req, res, backend, maxBodyBytes);
  };
}

async function handleBlobRequest(
  req: IncomingMessage,
  res: ServerResponse,
  backend: BlobBackend,
  maxBodyBytes: number,
): Promise<void> {
  try {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // Route: /blob/:sha256
    const match = /^\/blob\/([^/?#]+)$/.exec(url);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
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
