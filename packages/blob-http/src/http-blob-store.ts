/**
 * HttpBlobStore — BlobStorePort client over HTTP.
 *
 * Expects a server that implements:
 *   HEAD /blob/:sha256 → 200 (exists) | 404 (absent)
 *   GET  /blob/:sha256 → 200 + bytes  | 404
 *   PUT  /blob/:sha256 ← bytes → 201/204
 *
 * `get()` hash-verifies the received bytes to defend against a corrupt or
 * poisoned blob server: if sha256(bytes) ≠ requested sha, it throws.
 *
 * Auth: when constructed with a `token`, sends `Authorization: Bearer <token>`
 * on every verb (HEAD/GET/PUT). The server enforces it (401 on missing/wrong);
 * a 401 surfaces as a thrown error from each method (it is NOT treated as a
 * blob-absent 404). M1 uses one static token; per-device tokens are M4.
 *
 * Browser-safe by design: uses only the global `fetch`, `Uint8Array`, and
 * `@zync/core` — NO Node imports — so both the Obsidian plugin and the Node
 * headless client can depend on it without dragging `node:*` modules in.
 */

import {
  sha256OfBytes,
  BlobTransientError,
  BlobNotFoundError,
  BlobPermanentError,
} from "@zync/core";
import type { BlobStorePort, Sha256 } from "@zync/core";

/** Per-request ceiling. Generous enough for a large PUT on a slow link, small enough that an
 *  unreachable host cannot stall bootstrap. */
export const DEFAULT_BLOB_TIMEOUT_MS = 15_000;

export class HttpBlobStore implements BlobStorePort {
  private readonly baseUrl: string;
  /** Pre-built auth headers (empty when no token configured). Spread into each request. */
  private readonly authHeaders: Readonly<Record<string, string>>;

  /**
   * @param baseUrl e.g. "http://localhost:3000" — no trailing slash
   * @param token   optional static auth token; when set, sent as `Bearer` on every verb
   */
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token?: string, opts?: { timeoutMs?: number }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authHeaders =
      token !== undefined && token !== "" ? { Authorization: `Bearer ${token}` } : {};
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_BLOB_TIMEOUT_MS;
  }

  /** Map a non-ok HTTP status to the blob error taxonomy (drives the fetch queue's retry-vs-park). */
  private errorForStatus(sha: Sha256, verb: string, status: number): Error {
    if (status === 404) return new BlobNotFoundError({ sha });
    if (status === 401 || status === 403 || status === 413)
      return new BlobPermanentError({ sha, reason: `${verb} ${String(status)}` });
    if (status === 408 || status === 429 || status >= 500)
      return new BlobTransientError({ sha, cause: `${verb} ${String(status)}` });
    return new BlobPermanentError({ sha, reason: `${verb} ${String(status)}` }); // other 4xx: won't fix on retry
  }

  /**
   * Run `fetch`, mapping a thrown (rejected) fetch — DNS/connection-refused/timeout
   * network failures surface as a `TypeError` — to a retryable `BlobTransientError`.
   */
  private async fetchOrTransient(
    sha: Sha256,
    verb: string,
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    // BOUNDED: an unreachable host does NOT reject `fetch` on every platform — on Android it
    // simply never settles. bootstrap() awaits a blob op per on-disk blob, so one hung fetch
    // wedges bootstrap, which wedges start(), which leaves `engineReady` false forever and every
    // gated surface stuck on "Loading". Measured on a real tablet: start() never completed in
    // 5.5+ minutes offline. A timeout turns "hangs forever" into an ordinary transient error the
    // retry/park machinery already understands.
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      throw new BlobTransientError({ sha, cause: `${verb} network: ${String(cause)}` });
    }
  }

  async has(sha: Sha256): Promise<boolean> {
    const res = await this.fetchOrTransient(sha, "HEAD", `${this.baseUrl}/blob/${sha}`, {
      method: "HEAD",
      headers: { ...this.authHeaders },
    });
    if (res.status === 404) {
      // HEAD responses have no body, but cancel defensively for connection reuse.
      void res.body?.cancel();
      return false;
    }
    if (!res.ok) {
      void res.body?.cancel();
      throw this.errorForStatus(sha, "HEAD", res.status);
    }
    return true;
  }

  async put(sha: Sha256, data: Uint8Array): Promise<void> {
    const res = await this.fetchOrTransient(sha, "PUT", `${this.baseUrl}/blob/${sha}`, {
      method: "PUT",
      // `.slice()` yields a fresh Uint8Array<ArrayBuffer> — a `BodyInit` under BOTH the DOM lib (browser
      // plugin) and @types/node (headless), sidestepping the Uint8Array<ArrayBufferLike> generic mismatch.
      body: data.slice(),
      headers: { "Content-Type": "application/octet-stream", ...this.authHeaders },
    });
    if (!res.ok) {
      void res.body?.cancel();
      throw this.errorForStatus(sha, "PUT", res.status);
    }
    // Drain the (typically empty) success body so the connection can be reused.
    void res.body?.cancel();
  }

  async get(sha: Sha256): Promise<Uint8Array> {
    const res = await this.fetchOrTransient(sha, "GET", `${this.baseUrl}/blob/${sha}`, {
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      void res.body?.cancel();
      throw this.errorForStatus(sha, "GET", res.status);
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const actual = await sha256OfBytes(bytes);
    if (actual !== sha) {
      throw new Error(
        `HttpBlobStore.get: hash mismatch for ${sha} — received ${actual} (blob is corrupt or poisoned)`,
      );
    }
    return bytes;
  }
}
