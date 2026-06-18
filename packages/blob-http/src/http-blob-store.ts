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

import { sha256OfBytes } from "@zync/core";
import type { BlobStorePort, Sha256 } from "@zync/core";

export class HttpBlobStore implements BlobStorePort {
  private readonly baseUrl: string;
  /** Pre-built auth headers (empty when no token configured). Spread into each request. */
  private readonly authHeaders: Readonly<Record<string, string>>;

  /**
   * @param baseUrl e.g. "http://localhost:3000" — no trailing slash
   * @param token   optional static auth token; when set, sent as `Bearer` on every verb
   */
  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authHeaders =
      token !== undefined && token !== "" ? { Authorization: `Bearer ${token}` } : {};
  }

  async has(sha: Sha256): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/blob/${sha}`, {
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
      throw new Error(`HttpBlobStore.has: unexpected status ${String(res.status)} for ${sha}`);
    }
    return true;
  }

  async put(sha: Sha256, data: Uint8Array): Promise<void> {
    const res = await fetch(`${this.baseUrl}/blob/${sha}`, {
      method: "PUT",
      // `.slice()` yields a fresh Uint8Array<ArrayBuffer> — a `BodyInit` under BOTH the DOM lib (browser
      // plugin) and @types/node (headless), sidestepping the Uint8Array<ArrayBufferLike> generic mismatch.
      body: data.slice(),
      headers: { "Content-Type": "application/octet-stream", ...this.authHeaders },
    });
    if (!res.ok) {
      void res.body?.cancel();
      throw new Error(`HttpBlobStore.put: server returned ${String(res.status)} for ${sha}`);
    }
    // Drain the (typically empty) success body so the connection can be reused.
    void res.body?.cancel();
  }

  async get(sha: Sha256): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/blob/${sha}`, { headers: { ...this.authHeaders } });
    if (!res.ok) {
      void res.body?.cancel();
      throw new Error(`HttpBlobStore.get: server returned ${String(res.status)} for ${sha}`);
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
