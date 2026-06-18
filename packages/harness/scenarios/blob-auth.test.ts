/**
 * Scenario — blob-endpoint Bearer-token auth against the REAL containerized server.
 *
 * Phase-1 (M1-T3): the blob endpoint shares the relay's static token (`ZYNC_TOKEN`).
 * Every verb (HEAD/GET/PUT) requires `Authorization: Bearer <token>`; a missing or
 * wrong token MUST be rejected with 401 BEFORE any sha validation or body read. This
 * mirrors the in-process `file-endpoint.test.ts` auth suite but drives the LIVE
 * container over the host-published port (compose maps server `:8080` → host `:18080`),
 * proving the gate holds across the real HTTP path — the trustworthy gate.
 *
 * No devices are involved — this targets the server directly (like blob-hash-reject).
 * `resetStack()` in `beforeAll` guarantees a freshly-booted, healthy relay + a `--wait`
 * boot that has confirmed the blob port is listening.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { beforeAll, expect, test } from "vitest";
import { blobAuthHeader, resetStack, SERVER_BLOB_BASE, SERVER_TOKEN } from "../src/harness.js";

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/** Fetch the blob endpoint with the given method + optional headers; returns the status. */
async function blobStatus(
  method: "HEAD" | "GET" | "PUT",
  shaPath: string,
  opts: { headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<number> {
  const init: RequestInit = { method, headers: opts.headers ?? {} };
  if (opts.body !== undefined) init.body = Buffer.from(opts.body);
  const res = await fetch(`${SERVER_BLOB_BASE}/blob/${shaPath}`, init);
  await res.arrayBuffer().catch(() => undefined); // drain so the socket releases promptly
  return res.status;
}

beforeAll(async () => {
  await resetStack();
}, 180_000);

test("a missing token is rejected with 401 on HEAD / GET / PUT", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const sha = sha256Hex(body);

  expect(await blobStatus("HEAD", sha)).toBe(401);
  expect(await blobStatus("GET", sha)).toBe(401);
  expect(
    await blobStatus("PUT", sha, { headers: { "Content-Type": "application/octet-stream" }, body }),
  ).toBe(401);
});

test("a wrong token is rejected with 401", async () => {
  const sha = "a".repeat(64);
  expect(
    await blobStatus("HEAD", sha, { headers: { Authorization: "Bearer not-the-token" } }),
  ).toBe(401);
});

test("auth is checked BEFORE sha validation (malformed sha + no token → 401, not 400)", async () => {
  // An unauthorized caller must not learn whether a path sha is well-formed.
  expect(await blobStatus("HEAD", "A".repeat(64))).toBe(401); // uppercase (would be 400 if authed)
  expect(await blobStatus("HEAD", "tooshort")).toBe(401);
});

test("a correctly-tokened client round-trips PUT (201) → HEAD (200) → GET (200)", async () => {
  // The positive control: with the right Bearer, the endpoint behaves normally.
  const body = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const sha = sha256Hex(body);
  const headers = { "Content-Type": "application/octet-stream", ...blobAuthHeader };

  expect(await blobStatus("PUT", sha, { headers, body })).toBe(201);
  expect(await blobStatus("HEAD", sha, { headers: { ...blobAuthHeader } })).toBe(200);
  expect(await blobStatus("GET", sha, { headers: { ...blobAuthHeader } })).toBe(200);
});

test("with a valid token, a malformed sha still gets the normal 400 (auth passed, validation ran)", async () => {
  expect(await blobStatus("HEAD", "A".repeat(64), { headers: { ...blobAuthHeader } })).toBe(400);
  // Sanity: SERVER_TOKEN is the constant the positive control relies on.
  expect(blobAuthHeader.Authorization).toBe(`Bearer ${SERVER_TOKEN}`);
});
