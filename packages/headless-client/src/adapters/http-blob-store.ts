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
 * Uses the global `fetch` (Node 22+).
 */

import { sha256OfBytes } from "@zync/core";
import type { BlobStorePort, Sha256 } from "@zync/core";

export class HttpBlobStore implements BlobStorePort {
  private readonly baseUrl: string;

  /** @param baseUrl e.g. "http://localhost:3000" — no trailing slash */
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async has(sha: Sha256): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/blob/${sha}`, { method: "HEAD" });
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
      body: data,
      headers: { "Content-Type": "application/octet-stream" },
    });
    if (!res.ok) {
      void res.body?.cancel();
      throw new Error(`HttpBlobStore.put: server returned ${String(res.status)} for ${sha}`);
    }
    // Drain the (typically empty) success body so the connection can be reused.
    void res.body?.cancel();
  }

  async get(sha: Sha256): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/blob/${sha}`);
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
