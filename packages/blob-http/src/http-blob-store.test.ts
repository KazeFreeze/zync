import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { Sha256 } from "@zync/core";
import { sha256OfBytes } from "@zync/core";
import { HttpBlobStore } from "./http-blob-store.js";

// ---------------------------------------------------------------------------
// Tiny in-process blob server (Map-backed, no external deps)
//
// `requireToken`: when set, the server enforces `Authorization: Bearer <token>`
// on every verb (401 otherwise) — used by the auth tests. `lastAuth` records the
// Authorization header of the most recent request so the client-sends-it tests
// can assert what HttpBlobStore actually transmitted.
// ---------------------------------------------------------------------------

interface BlobServerHandle {
  server: http.Server;
  baseUrl: string;
  injectTampered(sha: string, bytes: Buffer): void;
  lastAuth(): string | undefined;
}

function startBlobServer(opts: { requireToken?: string } = {}): Promise<BlobServerHandle> {
  const blobs = new Map<string, Buffer>();
  const tampered = new Map<string, Buffer>(); // sha → wrong bytes
  let lastAuth: string | undefined;

  const server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;

    if (
      opts.requireToken !== undefined &&
      req.headers.authorization !== `Bearer ${opts.requireToken}`
    ) {
      res.writeHead(401).end();
      req.resume(); // drain any unauthorized body so the socket stays clean
      return;
    }

    const urlPath = req.url ?? "";
    const match = /^\/blob\/([0-9a-f]+)$/.exec(urlPath);
    if (match === null) {
      res.writeHead(404).end();
      return;
    }
    const sha = match[1];
    if (sha === undefined) {
      res.writeHead(400).end();
      return;
    }

    if (req.method === "HEAD" || req.method === "GET") {
      // Serve tampered bytes if injected (for corruption tests)
      const tamper = tampered.get(sha);
      const blob = tamper ?? blobs.get(sha);
      if (blob === undefined) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": String(blob.length) }).end();
      } else {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(blob);
      }
      return;
    }

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        blobs.set(sha, Buffer.concat(chunks));
        res.writeHead(204).end();
      });
      return;
    }

    res.writeHead(405).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        injectTampered: (sha, bytes) => tampered.set(sha, bytes),
        lastAuth: () => lastAuth,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests (no-auth server)
// ---------------------------------------------------------------------------

let handle: BlobServerHandle;
let store: HttpBlobStore;

beforeAll(async () => {
  handle = await startBlobServer();
  store = new HttpBlobStore(handle.baseUrl);
});

afterAll(() => {
  handle.server.close();
});

describe("HttpBlobStore — has()", () => {
  it("has() returns false for an absent blob", async () => {
    expect(await store.has("0".repeat(64) as Sha256)).toBe(false);
  });

  it("has() returns true after put()", async () => {
    const data = new TextEncoder().encode("hello blob");
    const hash = await sha256OfBytes(data);
    await store.put(hash, data);
    expect(await store.has(hash)).toBe(true);
  });
});

describe("HttpBlobStore — put() / get() round-trip", () => {
  it("get() returns the bytes that were put()", async () => {
    const data = new TextEncoder().encode("round-trip content");
    const hash = await sha256OfBytes(data);
    await store.put(hash, data);
    const retrieved = await store.get(hash);
    expect(new TextDecoder().decode(retrieved)).toBe("round-trip content");
  });

  it("get() returns the exact bytes (Uint8Array equality)", async () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
    const hash = await sha256OfBytes(data);
    await store.put(hash, data);
    const retrieved = await store.get(hash);
    expect(retrieved).toEqual(data);
  });

  it("put() multiple blobs, get() each independently", async () => {
    const a = new TextEncoder().encode("blob A");
    const b = new TextEncoder().encode("blob B");
    const hashA = await sha256OfBytes(a);
    const hashB = await sha256OfBytes(b);
    await store.put(hashA, a);
    await store.put(hashB, b);
    expect(new TextDecoder().decode(await store.get(hashA))).toBe("blob A");
    expect(new TextDecoder().decode(await store.get(hashB))).toBe("blob B");
  });
});

describe("HttpBlobStore — hash verification on get()", () => {
  it("get() throws when server returns tampered bytes", async () => {
    const data = new TextEncoder().encode("legitimate content");
    const hash = await sha256OfBytes(data);
    // Pre-register the real blob so has() works, then inject tampered bytes.
    await store.put(hash, data);
    const evil = Buffer.from("evil tampered content");
    handle.injectTampered(hash, evil);

    await expect(store.get(hash)).rejects.toThrow(/corrupt|hash mismatch|poison/i);
  });
});

describe("HttpBlobStore — error handling", () => {
  it("get() throws for a blob that does not exist on the server", async () => {
    await expect(store.get("a".repeat(64) as Sha256)).rejects.toThrow();
  });

  it("no token configured → no Authorization header is sent", async () => {
    await store.has("0".repeat(64) as Sha256);
    expect(handle.lastAuth()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auth tests (token-enforcing server)
// ---------------------------------------------------------------------------

describe("HttpBlobStore — Bearer-token auth", () => {
  const TOKEN = "s3cr3t-static-token";
  let authHandle: BlobServerHandle;

  beforeAll(async () => {
    authHandle = await startBlobServer({ requireToken: TOKEN });
  });

  afterAll(() => {
    authHandle.server.close();
  });

  it("sends `Authorization: Bearer <token>` on put/has/get when constructed with a token", async () => {
    const authed = new HttpBlobStore(authHandle.baseUrl, TOKEN);
    const data = new TextEncoder().encode("authed content");
    const hash = await sha256OfBytes(data);

    await authed.put(hash, data);
    expect(authHandle.lastAuth()).toBe(`Bearer ${TOKEN}`);

    expect(await authed.has(hash)).toBe(true);
    expect(authHandle.lastAuth()).toBe(`Bearer ${TOKEN}`);

    await authed.get(hash);
    expect(authHandle.lastAuth()).toBe(`Bearer ${TOKEN}`);
  });

  it("a tokenless client is rejected (401 surfaces as a throw, NOT a blob-absent false/404)", async () => {
    const anon = new HttpBlobStore(authHandle.baseUrl); // no token
    const data = new TextEncoder().encode("rejected content");
    const hash = await sha256OfBytes(data);

    // has() must NOT swallow 401 as "absent: false" — it must throw.
    await expect(anon.has(hash)).rejects.toThrow(/401/);
    await expect(anon.put(hash, data)).rejects.toThrow(/401/);
    await expect(anon.get(hash)).rejects.toThrow(/401/);
  });

  it("a wrong-token client is rejected (401)", async () => {
    const wrong = new HttpBlobStore(authHandle.baseUrl, "not-the-token");
    await expect(wrong.has("0".repeat(64) as Sha256)).rejects.toThrow(/401/);
  });
});
