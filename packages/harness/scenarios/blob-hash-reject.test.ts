/**
 * Scenario — blob hash-on-write rejection against the REAL containerized server.
 *
 * The relay's `/blob/:sha256` endpoint is content-addressed and self-defending: a PUT
 * whose body does NOT hash to the path sha is a poisoned/mislabeled blob and MUST be
 * rejected (400), and a path sha that is not exactly 64 lowercase hex chars MUST be
 * rejected (400) before any body is read. This mirrors the in-process
 * `file-endpoint.test.ts` but drives the LIVE container over the host-published port
 * (compose maps server `:8080` → host `:18080`), so it proves the property holds across
 * the real HTTP path, not just the in-process handler.
 *
 * No devices are involved — this targets the server directly. We still `resetStack()` in
 * `beforeAll` so the scenario runs against a freshly-booted, healthy relay regardless of
 * what ran before it (and so a `--wait` boot has confirmed the blob port is listening).
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { beforeAll, expect, test } from "vitest";
import { resetStack, SERVER_BLOB_BASE } from "../src/harness.js";

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");

async function putBlob(shaPath: string, body: Uint8Array): Promise<number> {
  const res = await fetch(`${SERVER_BLOB_BASE}/blob/${shaPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(body),
  });
  // Drain the body so the socket is released promptly.
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

beforeAll(async () => {
  await resetStack();
}, 180_000);

test("poisoned blob (body hash ≠ path sha) is rejected with 400", async () => {
  const real = new Uint8Array([10, 20, 30, 40, 50]);
  const wrong = new Uint8Array([99, 98, 97, 96, 95]);
  // Path advertises the sha of `real`, but we send `wrong` — a mislabeled/poisoned blob.
  const pathSha = sha256Hex(real);
  expect(sha256Hex(wrong)).not.toBe(pathSha); // sanity: the bodies genuinely differ

  expect(await putBlob(pathSha, wrong)).toBe(400);
});

test("a correctly-labeled blob (body hash === path sha) is accepted with 201", async () => {
  // The positive control: hash-on-write must ACCEPT a body that matches its path sha.
  const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(await putBlob(sha256Hex(body), body)).toBe(201);
});

test("malformed path sha is rejected with 400 (uppercase / short / long / non-hex)", async () => {
  const body = new Uint8Array([1, 2, 3]);
  const valid = sha256Hex(body); // 64 lowercase hex

  // Uppercase: the endpoint requires strictly LOWERCASE hex.
  expect(await putBlob(valid.toUpperCase(), body)).toBe(400);
  // Too short (63 chars).
  expect(await putBlob(valid.slice(0, 63), body)).toBe(400);
  // Too long (65 chars).
  expect(await putBlob(`${valid}a`, body)).toBe(400);
  // Right length, non-hex character ('g').
  expect(await putBlob(`g${valid.slice(1)}`, body)).toBe(400);
});
