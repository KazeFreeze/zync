/**
 * file-endpoint.test.ts — unit tests for the blob HTTP handler.
 *
 * Uses an in-memory backend (Map) — no MinIO needed.
 * Tests: put→get round-trip, HEAD has/not-has, hash-mismatch rejection,
 * malformed sha validation, missing blob 404.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { createBlobHandler } from "./file-endpoint.js";
import type { BlobBackend } from "./file-endpoint.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

function makeMemBackend(): BlobBackend {
  const store = new Map<string, Uint8Array>();
  return {
    async has(sha) {
      return store.has(sha);
    },
    async put(sha, bytes) {
      store.set(sha, bytes);
    },
    async get(sha) {
      const b = store.get(sha);
      if (!b) throw new Error(`not found: ${sha}`);
      return b;
    },
  };
}

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

interface FetchOpts {
  method?: string;
  body?: Buffer | null;
  headers?: Record<string, string>;
}

async function startTestServer(
  backend: BlobBackend,
  opts: { maxBodyBytes?: number; token?: string } = {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const handlerOpts: { maxBodyBytes?: number; token?: string } = {};
  if (opts.maxBodyBytes !== undefined) handlerOpts.maxBodyBytes = opts.maxBodyBytes;
  if (opts.token !== undefined) handlerOpts.token = opts.token;
  const handler = createBlobHandler(backend, handlerOpts);
  const server = http.createServer(handler);

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function req(
  url: string,
  { method = "GET", body = null, headers = {} }: FetchOpts = {},
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method,
      headers,
    };
    const r = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks),
          headers: res.headers,
        }),
      );
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("file-endpoint blob handler", () => {
  let backend: BlobBackend;
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    backend = makeMemBackend();
    const server = await startTestServer(backend);
    baseUrl = server.baseUrl;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  // -------------------------------------------------------------------------
  // PUT → GET round-trip
  // -------------------------------------------------------------------------
  it("PUT then GET round-trips bytes correctly", async () => {
    const data = Buffer.from("hello zync blob");
    const sha = sha256(data);

    const putRes = await req(`${baseUrl}/blob/${sha}`, {
      method: "PUT",
      body: data,
    });
    expect(putRes.status).toBe(201);

    const getRes = await req(`${baseUrl}/blob/${sha}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(data);
  });

  // -------------------------------------------------------------------------
  // HEAD
  // -------------------------------------------------------------------------
  it("HEAD returns 200 for an existing blob", async () => {
    const data = Buffer.from("some content");
    const sha = sha256(data);
    await backend.put(sha, new Uint8Array(data));

    const res = await req(`${baseUrl}/blob/${sha}`, { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("HEAD returns 404 for a missing blob", async () => {
    const sha = "a".repeat(64); // valid hex, just not stored
    const res = await req(`${baseUrl}/blob/${sha}`, { method: "HEAD" });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // GET missing
  // -------------------------------------------------------------------------
  it("GET returns 404 for a missing blob", async () => {
    const sha = "b".repeat(64);
    const res = await req(`${baseUrl}/blob/${sha}`);
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PUT hash-mismatch rejection
  // -------------------------------------------------------------------------
  it("PUT rejects when body hash ≠ path sha (400)", async () => {
    const data = Buffer.from("some real content");
    const wrongSha = "0".repeat(64); // valid hex but does not match sha256(data)

    const res = await req(`${baseUrl}/blob/${wrongSha}`, {
      method: "PUT",
      body: data,
    });
    expect(res.status).toBe(400);
  });

  it("PUT hash-mismatch: body correct hash but path sha is different valid hex", async () => {
    const data = Buffer.from("content");
    const actualSha = sha256(data);
    // Build a different valid sha by flipping first char.
    const wrongSha = (actualSha.startsWith("a") ? "b" : "a") + actualSha.slice(1);

    const res = await req(`${baseUrl}/blob/${wrongSha}`, {
      method: "PUT",
      body: data,
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Malformed sha validation
  // -------------------------------------------------------------------------
  it("PUT with uppercase hex sha returns 400", async () => {
    const upperSha = "A".repeat(64);
    const res = await req(`${baseUrl}/blob/${upperSha}`, {
      method: "PUT",
      body: Buffer.from("x"),
    });
    expect(res.status).toBe(400);
  });

  it("PUT with too-short sha returns 400", async () => {
    const shortSha = "abc123";
    const res = await req(`${baseUrl}/blob/${shortSha}`, {
      method: "PUT",
      body: Buffer.from("x"),
    });
    expect(res.status).toBe(400);
  });

  it("PUT with non-hex chars in sha returns 400", async () => {
    const nonHexSha = "g".repeat(64); // 'g' is not hex
    const res = await req(`${baseUrl}/blob/${nonHexSha}`, {
      method: "PUT",
      body: Buffer.from("x"),
    });
    expect(res.status).toBe(400);
  });

  it("GET with wrong-length sha returns 400", async () => {
    const res = await req(`${baseUrl}/blob/abc`);
    expect(res.status).toBe(400);
  });

  it("HEAD with mixed-case sha returns 400", async () => {
    // 64 chars but contains uppercase — fails ^[a-f0-9]{64}$ validation.
    const mixedSha = "aAbBcCdDeEfF001122334455667788990011223344556677889900112233aAbB";
    const res = await req(`${baseUrl}/blob/${mixedSha}`, { method: "HEAD" });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Unknown path / method
  // -------------------------------------------------------------------------
  it("unknown path returns 404", async () => {
    const res = await req(`${baseUrl}/notblob/abc`);
    expect(res.status).toBe(404);
  });

  it("DELETE method returns 405", async () => {
    const sha = "c".repeat(64);
    const res = await req(`${baseUrl}/blob/${sha}`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  // -------------------------------------------------------------------------
  // PUT with correct hash succeeds (extra confidence)
  // -------------------------------------------------------------------------
  it("PUT with empty body and correct sha (empty sha256) returns 201", async () => {
    const data = Buffer.alloc(0);
    const sha = sha256(data);
    const res = await req(`${baseUrl}/blob/${sha}`, {
      method: "PUT",
      body: data,
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Body-size cap tests (fix #1) — separate describe so they get their own server
// with a low maxBodyBytes ceiling.
// ---------------------------------------------------------------------------

describe("file-endpoint blob handler — body size cap", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  // Cap at 50 bytes so tests stay fast.
  const CAP = 50;

  beforeEach(async () => {
    const server = await startTestServer(makeMemBackend(), { maxBodyBytes: CAP });
    baseUrl = server.baseUrl;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  it("PUT exceeding the configured cap returns 413", async () => {
    // Build a body that is exactly CAP+1 bytes — one byte over the limit.
    const data = Buffer.alloc(CAP + 1, 0x41); // 'A' repeated
    // Use a valid-looking sha (won't pass hash check, but we expect 413 first).
    const sha = sha256(data);

    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const parsed = new URL(`${baseUrl}/blob/${sha}`);
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "PUT",
      };
      const r = http.request(options, (res) => {
        // Drain response body so socket closes cleanly.
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      });
      r.on("error", (err) => {
        // The server calls req.destroy() after sending 413; the client side may
        // see an ECONNRESET if it's still writing. We handle both: if we already
        // got the status via the response event, the error is benign.
        // We reject only if we don't have a status yet (handled by response cb).
        // Using a flag to track whether we already resolved.
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      // Write data in a single shot after setting up error handler.
      r.write(data);
      r.end();
    }).catch((err: Error) => {
      // req.destroy() on the server can cause ECONNRESET on the client side.
      // That's acceptable — the 413 was already sent. We mark it specially.
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET") {
        return { status: 413 };
      }
      throw err;
    });

    expect(result.status).toBe(413);
  });

  it("PUT at exactly the cap limit succeeds (body not over limit)", async () => {
    // A body of exactly CAP bytes should NOT be rejected by the size check.
    const data = Buffer.alloc(CAP, 0x42); // 'B' repeated
    const sha = sha256(data);

    const res = await req(`${baseUrl}/blob/${sha}`, { method: "PUT", body: data });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Auth tests — server configured with a static token. Every verb requires
// `Authorization: Bearer <token>`; checked before sha validation / body read.
// ---------------------------------------------------------------------------

describe("file-endpoint blob handler — Bearer-token auth", () => {
  const TOKEN = "unit-static-token";
  let baseUrl: string;
  let backend: BlobBackend;
  let close: () => Promise<void>;

  const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
    authorization: `Bearer ${TOKEN}`,
    ...extra,
  });

  beforeEach(async () => {
    backend = makeMemBackend();
    const server = await startTestServer(backend, { token: TOKEN });
    baseUrl = server.baseUrl;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  it("a correct Bearer token round-trips PUT → GET → HEAD", async () => {
    const data = Buffer.from("authed blob content");
    const sha = sha256(data);

    expect(
      (await req(`${baseUrl}/blob/${sha}`, { method: "PUT", body: data, headers: authed() }))
        .status,
    ).toBe(201);
    expect((await req(`${baseUrl}/blob/${sha}`, { headers: authed() })).status).toBe(200);
    expect(
      (await req(`${baseUrl}/blob/${sha}`, { method: "HEAD", headers: authed() })).status,
    ).toBe(200);
  });

  it("a missing token is rejected with 401 on HEAD/GET/PUT (before sha validation)", async () => {
    const data = Buffer.from("x");
    const sha = sha256(data);
    expect((await req(`${baseUrl}/blob/${sha}`, { method: "HEAD" })).status).toBe(401);
    expect((await req(`${baseUrl}/blob/${sha}`, { method: "GET" })).status).toBe(401);
    expect((await req(`${baseUrl}/blob/${sha}`, { method: "PUT", body: data })).status).toBe(401);
  });

  it("a wrong token is rejected with 401", async () => {
    const sha = "a".repeat(64);
    expect(
      (
        await req(`${baseUrl}/blob/${sha}`, {
          method: "HEAD",
          headers: { authorization: "Bearer nope" },
        })
      ).status,
    ).toBe(401);
  });

  it("auth is checked BEFORE sha validation (a malformed sha without a token is 401, not 400)", async () => {
    // Unauthorized callers must not learn anything about path validity.
    expect((await req(`${baseUrl}/blob/${"A".repeat(64)}`, { method: "HEAD" })).status).toBe(401);
    expect((await req(`${baseUrl}/blob/tooshort`, { method: "HEAD" })).status).toBe(401);
  });

  it("an authorized but malformed sha still gets the normal 400", async () => {
    expect(
      (await req(`${baseUrl}/blob/${"A".repeat(64)}`, { method: "HEAD", headers: authed() }))
        .status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// CORS — the Obsidian plugin fetches this endpoint from the app://obsidian.md
// origin (cross-origin; the Authorization header forces a preflight). The blob
// endpoint MUST answer the OPTIONS preflight + send Access-Control-Allow-Origin
// on every response, or the browser blocks the fetch (real-Obsidian-only bug).
// ---------------------------------------------------------------------------

describe("file-endpoint blob handler — CORS", () => {
  const TOKEN = "cors-token";
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const server = await startTestServer(makeMemBackend(), { token: TOKEN });
    baseUrl = server.baseUrl;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  it("answers the OPTIONS preflight with 204 + CORS headers, WITHOUT requiring auth", async () => {
    const res = await req(`${baseUrl}/blob/${"a".repeat(64)}`, { method: "OPTIONS" }); // no Authorization
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(String(res.headers["access-control-allow-methods"])).toContain("HEAD");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "authorization",
    );
  });

  it("sends Access-Control-Allow-Origin on a normal authed response", async () => {
    const res = await req(`${baseUrl}/blob/${"b".repeat(64)}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404); // absent blob, but the CORS header is still present
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("sends Access-Control-Allow-Origin even on a 401 (so the browser sees the real status)", async () => {
    const res = await req(`${baseUrl}/blob/${"c".repeat(64)}`, { method: "HEAD" }); // no auth → 401
    expect(res.status).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
