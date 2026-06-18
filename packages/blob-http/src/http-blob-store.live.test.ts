/**
 * Live HttpBlobStore ↔ real blob endpoint conformance.
 *
 * The sibling `http-blob-store.test.ts` exercises the client against a hand-rolled fake server.
 * THIS suite points the SAME real {@link HttpBlobStore} at the REAL `createBlobHandler` from
 * `@zync/server` (the production blob endpoint), in-process on an ephemeral port — proving the
 * client honors the same contract over the real wire, including the SERVER-SIDE guarantees the fake
 * doesn't implement: hash-on-write rejection (400), strict sha256 validation (400), and (last
 * describe) Bearer-token auth (401) enforced across HEAD/GET/PUT.
 *
 * Backend: an in-memory Map `BlobBackend` (the S3BlobStore-over-MinIO live path needs MinIO via
 * Docker and is DEFERRED to a later task). The Map backend lets us inject a tampered key whose
 * served bytes don't match its sha, so the client's hash-verify-on-read is exercised end-to-end
 * against the real endpoint (the endpoint serves backend bytes verbatim — it does NOT verify reads).
 */

import * as http from "node:http";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sha256 } from "@zync/core";
import { sha256OfBytes } from "@zync/core";
import { createBlobHandler } from "@zync/server/file-endpoint";
import type { BlobBackend } from "@zync/server/file-endpoint";
import { HttpBlobStore } from "./http-blob-store.js";

/** sha256 hex of bytes, computed independently of the client (so the test is self-checking). */
function shaHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * In-memory Map backend with a TAMPER override: `tamper(sha, wrongBytes)` makes `get(sha)` return
 * bytes that do NOT hash to `sha`. The real endpoint serves them verbatim, so the client's
 * hash-verify-on-read must reject — a real (not mocked-away) corruption path.
 */
class MapBlobBackend implements BlobBackend {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly tampered = new Map<string, Uint8Array>();

  has(sha: string): Promise<boolean> {
    return Promise.resolve(this.tampered.has(sha) || this.blobs.has(sha));
  }

  put(sha: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(sha, bytes);
    return Promise.resolve();
  }

  get(sha: string): Promise<Uint8Array> {
    const bytes = this.tampered.get(sha) ?? this.blobs.get(sha);
    // Contract: BlobBackend.get MUST throw when the key is absent (handler replies 404).
    if (bytes === undefined) throw new Error(`absent: ${sha}`);
    return Promise.resolve(bytes);
  }

  tamper(sha: string, wrongBytes: Uint8Array): void {
    this.tampered.set(sha, wrongBytes);
  }
}

interface LiveBlobServer {
  server: http.Server;
  baseUrl: string;
  backend: MapBlobBackend;
}

async function startLiveBlobServer(opts: { token?: string } = {}): Promise<LiveBlobServer> {
  const backend = new MapBlobBackend();
  const handlerOpts = opts.token !== undefined ? { token: opts.token } : {};
  const server = http.createServer(createBlobHandler(backend, handlerOpts));
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("could not determine ephemeral port");
  }
  return { server, backend, baseUrl: `http://127.0.0.1:${String(addr.port)}` };
}

async function closeLiveServer(s: LiveBlobServer): Promise<void> {
  s.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    s.server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

let live: LiveBlobServer;
let store: HttpBlobStore;

beforeAll(async () => {
  live = await startLiveBlobServer();
  store = new HttpBlobStore(live.baseUrl);
});

afterAll(async () => {
  await closeLiveServer(live);
});

describe("HttpBlobStore ↔ real blob endpoint [live] — round-trip", () => {
  it("put → get returns identical bytes; has() true after put, false for unknown sha", async () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x80]);
    const sha = await sha256OfBytes(data);

    expect(await store.has(sha)).toBe(false);
    await store.put(sha, data);
    expect(await store.has(sha)).toBe(true);

    const got = await store.get(sha);
    expect(got).toEqual(data);

    // An unknown (but well-formed) sha is absent.
    expect(await store.has("b".repeat(64) as Sha256)).toBe(false);
  });

  it("round-trips a larger UTF-8 payload byte-for-byte", async () => {
    const data = new TextEncoder().encode("zync live blob — λ ∑ 🜁 ".repeat(64));
    const sha = await sha256OfBytes(data);
    await store.put(sha, data);
    expect(new TextDecoder().decode(await store.get(sha))).toBe(new TextDecoder().decode(data));
  });
});

describe("HttpBlobStore ↔ real blob endpoint [live] — hash-verify on read", () => {
  it("get() rejects when the server serves bytes whose hash ≠ requested sha", async () => {
    // Correct blob first so the key exists and has() is true.
    const data = new TextEncoder().encode("authentic blob");
    const sha = await sha256OfBytes(data);
    await store.put(sha, data);
    expect(await store.has(sha)).toBe(true);

    // Inject bytes that do NOT hash to `sha`; the real endpoint serves them verbatim.
    const evil = new TextEncoder().encode("evil tampered payload");
    expect(shaHex(evil)).not.toBe(sha);
    live.backend.tamper(sha, evil);

    await expect(store.get(sha)).rejects.toThrow(/hash mismatch|corrupt|poison/i);
  });

  it("get() rejects for a blob absent on the server (real 404 → thrown)", async () => {
    await expect(store.get("c".repeat(64) as Sha256)).rejects.toThrow();
  });
});

describe("HttpBlobStore ↔ real blob endpoint [live] — server hash-on-write & validation", () => {
  it("client put() throws when the body's real hash ≠ the path sha (server 400)", async () => {
    // A WELL-FORMED but WRONG sha: 64 hex chars that don't match the body's hash. The server
    // computes sha256(body), sees the mismatch, and replies 400 → HttpBlobStore.put rejects.
    const data = new TextEncoder().encode("body that won't match the claimed sha");
    const wrongSha = "a".repeat(64) as Sha256;
    expect(shaHex(data)).not.toBe(wrongSha);

    await expect(store.put(wrongSha, data)).rejects.toThrow(/400/);

    // The poisoned write must NOT have been stored.
    expect(await store.has(wrongSha)).toBe(false);
  });

  it("a malformed sha (uppercase / too short) is rejected with 400 by the real endpoint", async () => {
    const body = new Uint8Array([0x01, 0x02, 0x03]);

    // Uppercase hex — the endpoint requires exactly 64 LOWERCASE hex chars.
    const upper = await fetch(`${live.baseUrl}/blob/${"A".repeat(64)}`, {
      method: "PUT",
      body,
      headers: { "Content-Type": "application/octet-stream" },
    });
    void upper.body?.cancel();
    expect(upper.status).toBe(400);

    // Too short.
    const short = await fetch(`${live.baseUrl}/blob/abc123`, {
      method: "PUT",
      body,
      headers: { "Content-Type": "application/octet-stream" },
    });
    void short.body?.cancel();
    expect(short.status).toBe(400);

    // The client surfaces the malformed-sha 400 as a thrown error from put().
    await expect(store.put("ABCDEF" as Sha256, body)).rejects.toThrow(/400/);
  });
});

describe("HttpBlobStore ↔ real blob endpoint [live] — Bearer-token auth", () => {
  const TOKEN = "live-static-token";
  let authed: LiveBlobServer;

  beforeAll(async () => {
    authed = await startLiveBlobServer({ token: TOKEN });
  });

  afterAll(async () => {
    await closeLiveServer(authed);
  });

  it("a token-bearing client round-trips through the real authed endpoint", async () => {
    const client = new HttpBlobStore(authed.baseUrl, TOKEN);
    const data = new TextEncoder().encode("authed live content");
    const sha = await sha256OfBytes(data);

    expect(await client.has(sha)).toBe(false);
    await client.put(sha, data);
    expect(await client.has(sha)).toBe(true);
    expect(await client.get(sha)).toEqual(data);
  });

  it("the real endpoint rejects a missing token with 401 on HEAD/GET/PUT", async () => {
    const body = new Uint8Array([1, 2, 3]);
    const sha = await sha256OfBytes(body);

    for (const method of ["HEAD", "GET"] as const) {
      const res = await fetch(`${authed.baseUrl}/blob/${sha}`, { method });
      void res.body?.cancel();
      expect(res.status).toBe(401);
    }
    const put = await fetch(`${authed.baseUrl}/blob/${sha}`, {
      method: "PUT",
      body,
      headers: { "Content-Type": "application/octet-stream" },
    });
    void put.body?.cancel();
    expect(put.status).toBe(401);
  });

  it("the real endpoint rejects a wrong token with 401", async () => {
    const res = await fetch(`${authed.baseUrl}/blob/${"a".repeat(64)}`, {
      method: "HEAD",
      headers: { Authorization: "Bearer wrong-token" },
    });
    void res.body?.cancel();
    expect(res.status).toBe(401);
  });

  it("a tokenless HttpBlobStore surfaces the 401 as a throw (not blob-absent)", async () => {
    const anon = new HttpBlobStore(authed.baseUrl); // no token
    await expect(anon.has("a".repeat(64) as Sha256)).rejects.toThrow(/401/);
  });
});
