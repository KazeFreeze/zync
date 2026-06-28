/**
 * index.ts — Zync server entrypoint.
 *
 * Composes two services:
 *   1. Hocuspocus WebSocket relay (content-opaque CRDT relay + snapshot persistence).
 *   2. Blob HTTP endpoint (GET/PUT /blob/:sha256, content-addressed storage).
 *
 * Exports `createServer(config)` for in-process use (transport-conformance tests).
 * The `main()` function reads config from env and is the Docker entrypoint.
 *
 * The blob endpoint shares the relay's static `token` (ZYNC_TOKEN): every verb
 * requires `Authorization: Bearer <token>`. Per-device tokens are M4.
 */

import * as http from "node:http";
import { createRelay } from "./relay.js";
import { createBlobHandler } from "./file-endpoint.js";
import { S3BlobStore } from "./s3-blobstore.js";
import type { BlobBackend } from "./file-endpoint.js";

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** Hocuspocus WebSocket port (ZYNC_PORT, default 1234). */
  relayPort: number;
  /** Blob HTTP server port (ZYNC_BLOB_PORT, default 8080). */
  blobPort: number;
  /** Static auth token shared between relay + client (ZYNC_TOKEN). */
  token: string;
  /** Directory for Yjs snapshot persistence (ZYNC_SNAPSHOT_DIR). */
  snapshotDir: string;
  /** Injectable blob backend — defaults to S3BlobStore in main(). */
  blobBackend: BlobBackend;
  /**
   * HARNESS-ONLY blob GET latch (ms, ZYNC_BLOB_GET_DELAY_MS). When > 0, every blob GET sleeps
   * this long + a `/_blob-stats` peak-concurrency route is exposed (see createBlobHandler). 0 in
   * production — no delay, no extra route. Used by the blob-scale gate to widen + measure the
   * prose-converges-before-blobs-settle decoupling window.
   */
  blobGetDelayMs?: number;
}

export interface ServerHandle {
  /** Gracefully shut down both the relay and the blob HTTP server. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// createServer — importable, in-process composition
// ---------------------------------------------------------------------------

export async function createServer(config: ServerConfig): Promise<ServerHandle> {
  // 1. Start the relay.
  const relay = createRelay({
    port: config.relayPort,
    token: config.token,
    snapshotDir: config.snapshotDir,
  });
  await relay.hocuspocus.listen();
  console.log(`[zync] relay on ws://0.0.0.0:${config.relayPort}`);

  // 2. Start the blob HTTP server (shares the relay's static token).
  const blobHandler = createBlobHandler(config.blobBackend, {
    token: config.token,
    getDelayMs: config.blobGetDelayMs ?? 0,
  });
  const blobServer = http.createServer(blobHandler);

  await new Promise<void>((resolve, reject) => {
    blobServer.on("error", reject);
    blobServer.listen(config.blobPort, () => {
      console.log(`[zync] blob  on http://0.0.0.0:${config.blobPort}`);
      resolve();
    });
  });

  return {
    async close() {
      // closeAllConnections() (Node 18.2+) terminates keep-alive sockets
      // immediately so blobServer.close() resolves without waiting for
      // idle clients to time out. Safe to call even if no connections exist.
      blobServer.closeAllConnections();
      await Promise.all([
        relay.close(),
        new Promise<void>((resolve, reject) =>
          blobServer.close((err) => (err ? reject(err) : resolve())),
        ),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// main — Docker/process entrypoint driven by env vars
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const relayPort = Number(process.env.ZYNC_PORT ?? 1234);
  const blobPort = Number(process.env.ZYNC_BLOB_PORT ?? 8080);
  const token = process.env.ZYNC_TOKEN ?? "dev-static-token";
  const snapshotDir = process.env.ZYNC_SNAPSHOT_DIR ?? "/data/snapshots";
  // HARNESS-ONLY: 0 in production (no latch, no /_blob-stats). The blob-scale gate sets it.
  const blobGetDelayMs = Number(process.env.ZYNC_BLOB_GET_DELAY_MS ?? 0);

  const s3Endpoint = process.env.ZYNC_S3_ENDPOINT ?? "http://localhost:9000";
  const s3Bucket = process.env.ZYNC_S3_BUCKET ?? "zync-blobs";
  const s3Region = process.env.ZYNC_S3_REGION ?? "us-east-1";
  const s3AccessKey = process.env.ZYNC_S3_ACCESS_KEY ?? "minioadmin";
  const s3SecretKey = process.env.ZYNC_S3_SECRET_KEY ?? "minioadmin";

  const blobBackend = new S3BlobStore({
    endpoint: s3Endpoint,
    region: s3Region,
    bucket: s3Bucket,
    accessKeyId: s3AccessKey,
    secretAccessKey: s3SecretKey,
    forcePathStyle: true,
  });

  await createServer({
    relayPort,
    blobPort,
    token,
    snapshotDir,
    blobBackend,
    blobGetDelayMs,
  });
}

// Run main only when this file is the process entrypoint (not when imported).
// ESM pattern: compare import.meta.url to process.argv[1].
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const thisFile = fileURLToPath(import.meta.url);
const entryFile = resolve(process.argv[1] ?? "");
if (thisFile === entryFile) {
  main().catch((err: unknown) => {
    console.error("[zync] fatal:", err);
    process.exit(1);
  });
}
