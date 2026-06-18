/**
 * Scenario — blob sync via the content-addressed blob endpoint (eager/lazy).
 *
 * Exercises the BLOB pipeline over real containers: a binary blob and a `.canvas`
 * (structured-blob) authored on A must reach the relay's content-addressed store via
 * the `/blob/:sha256` endpoint (NOT the CRDT tree), while a sibling prose `.md` rides
 * the CRDT to B. This pins the routing-matrix split that `classify.ts` defines:
 *   - `.bin` / large binary → `binary-blob`  → blob endpoint
 *   - `.canvas` (JSON)      → `structured-blob` → blob endpoint
 *   - `.md` (valid UTF-8, < cap) → `crdt-prose` → CRDT tree
 *
 * THE WRITE MUST BE LIVE (after `/sync/start`). A blob PRESENT AT BOOTSTRAP is invisible
 * to sync: `engine.bootstrap()` skips every non-prose route (`if (route !== "crdt-prose")
 * continue;`), and the vault watcher only subscribes AFTER start — so a fixture-loaded
 * blob fires no `create` event and is never published. We therefore write the blobs as
 * LIVE `/fs/write`s after start (the realistic external-writer flow), which fires the
 * watcher → `onWrite` → `blobEngine.onLocalBlobWrite` → bytes PUT to the endpoint +
 * manifest entry published.
 *
 * ── EAGER FOLLOWER MATERIALIZATION (Fix 3, now validated over the real network) ───────
 * The follower (B) MATERIALIZES synced blobs to its disk. The headless daemon now defaults
 * `blobPolicy: "eager"` (daemon.ts configFromEnv; `ZYNC_BLOB_POLICY=lazy` opts out), so
 * `BlobEngine.onManifestChange` fetches the bytes from the shared content store and writes
 * them to B's vault — echo-guarded so the materialize never loops, and the blob manifest is
 * counted as pending until it lands (honest quiescence). Both halves of this scenario are now
 * ACTIVE: the first asserts blob bytes reach the content-addressed store via the endpoint
 * (with a matching sha, OFF the CRDT) AND that B eventually materializes them sha-identically;
 * the second (formerly the skipped half) asserts the same materialization via `waitConverged`.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  blobAuthHeader,
  device,
  resetStack,
  SERVER_BLOB_BASE,
  sleep,
  waitConverged,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const CANVAS = "diagrams/board.canvas"; // structured-blob (JSON)
const BIN = "assets/live.bin"; // binary-blob
const PROSE = "notes/live-note.md"; // crdt-prose (rides the CRDT to B)

/** A small, deterministic binary payload that is NOT valid UTF-8 (so it cannot be prose). */
const BIN_BYTES = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 128, 129, 130, 4, 5, 6, 7]);
const CANVAS_JSON = JSON.stringify({
  nodes: [{ id: "n1", type: "text", text: "live canvas node", x: 0, y: 0, width: 200, height: 60 }],
  edges: [],
});

const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes))
    .digest("hex");

/** GET the blob from the relay's published content-addressed endpoint; null on 404. */
async function serverBlob(sha: string): Promise<Uint8Array | null> {
  const res = await fetch(`${SERVER_BLOB_BASE}/blob/${sha}`, { headers: { ...blobAuthHeader } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /blob/${sha} → ${String(res.status)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Poll until the relay store has the blob for `sha` (its bytes hash back to `sha`). Bounded. */
async function waitServerHasBlob(sha: string, timeoutMs: number): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await a.flush().catch(() => undefined);
    const bytes = await serverBlob(sha);
    if (bytes !== null) return bytes;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitServerHasBlob(${sha.slice(0, 12)}) timed out after ${String(timeoutMs)}ms`,
      );
    }
    await sleep(500);
  }
}

/**
 * Poll until B's `/fs/tree` carries `path` with a sha matching A's. Used for BOTH the prose
 * path (rides the CRDT) and — now that the eager blob policy (Fix 3) is the headless-follower
 * default — the materialized blob paths (B fetches the bytes from the shared content store and
 * writes them to its own disk). Bounded; throws on timeout.
 */
async function waitPathConverged(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.all([a.flush().catch(() => undefined), b.flush().catch(() => undefined)]);
    const aSha = (await a.tree())[path]?.sha256;
    const bSha = (await b.tree())[path]?.sha256;
    if (aSha !== undefined && aSha === bSha) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitPathConverged(${path}) timed out after ${String(timeoutMs)}ms (A=${String(aSha).slice(0, 12)}, B=${String(bSha).slice(0, 12)})`,
      );
    }
    await sleep(500);
  }
}

beforeAll(async () => {
  await resetStack();
  // Both devices boot EMPTY and start: the realistic external-writer flow writes the
  // blobs LIVE after start (a bootstrap-present blob would never publish — see header).
  await a.start();
  await b.start();
  await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });
}, 180_000);

afterAll(async () => {
  // No partition lever used; nothing to heal.
});

test("blobs route to the content-addressed endpoint (not the CRDT); prose rides the CRDT", async () => {
  const binSha = sha256Hex(BIN_BYTES);
  const canvasSha = sha256Hex(CANVAS_JSON);

  // LIVE writes on A (after start) → watcher → onLocalBlobWrite → PUT to the blob endpoint.
  await a.write(BIN, BIN_BYTES);
  await a.write(CANVAS, CANVAS_JSON);
  await a.write(PROSE, "# Live note\n\nA prose note authored live; this rides the CRDT to B.\n");

  // 1. The binary blob's bytes reached the relay's content-addressed store, byte-exact.
  const serverBin = await waitServerHasBlob(binSha, 60_000);
  expect(Buffer.from(serverBin).equals(Buffer.from(BIN_BYTES))).toBe(true);
  expect(sha256Hex(serverBin)).toBe(binSha); // the endpoint is genuinely content-addressed

  // 2. The .canvas (structured-blob) ALSO went through the blob endpoint, not the CRDT.
  const serverCanvas = await waitServerHasBlob(canvasSha, 60_000);
  expect(Buffer.from(serverCanvas).toString("utf8")).toBe(CANVAS_JSON);

  // 3. The prose note rode the CRDT and converged to B byte-identical.
  await waitPathConverged(PROSE, 60_000);
  expect(await b.read(PROSE)).toContain("rides the CRDT to B");

  // 4. The blobs rode the content-addressed endpoint (asserted in #1/#2), NOT the CRDT —
  //    and with the eager blob policy (Fix 3, now the headless-follower default) B
  //    materializes their bytes to its own disk from the shared store. So B's `/fs/tree`
  //    eventually carries the blob paths with shas that match A's (sha-identical
  //    materialization), proving the route was the blob pipeline (content-addressed).
  await waitPathConverged(BIN, 60_000);
  await waitPathConverged(CANVAS, 60_000);
  const treeA = await a.tree();
  const treeB = await b.tree();
  expect(treeB[BIN]?.sha256).toBe(binSha);
  expect(treeB[CANVAS]?.sha256).toBe(canvasSha);
  expect(treeB[BIN]?.sha256).toBe(treeA[BIN]?.sha256);
  expect(treeB[CANVAS]?.sha256).toBe(treeA[CANVAS]?.sha256);
  expect(treeB[PROSE]).toBeDefined();
});

/**
 * EAGER-BLOB MATERIALIZATION (Fix 3 — validated over real containers on this branch).
 *
 * The headless daemon defaults `blobPolicy: "eager"` (daemon.ts configFromEnv), so the
 * follower fetches a synced blob's bytes from the shared content store and writes them to
 * its own disk on manifest change. After A writes the blob LIVE and the relay store has it,
 * `waitConverged([A, B])` settles (the blob materialization is counted as pending until it
 * lands — honest quiescence), and B's disk carries the blob with a sha matching A's.
 */
describe("blob CONTENT converges to the follower's disk (eager-blob materialization)", () => {
  test("B materializes A's blob to disk with a matching sha (eager + lazy)", async () => {
    const binSha = sha256Hex(BIN_BYTES);
    await a.write(BIN, BIN_BYTES);
    await waitServerHasBlob(binSha, 60_000);
    await waitConverged(["device-a", "device-b"], { timeoutMs: 60_000 });

    expect(await b.exists(BIN)).toBe(true);
    const bBytes = await b.readBytes(BIN);
    expect(sha256Hex(bBytes)).toBe(binSha);
  });
});
