/**
 * index.ts — Zync server entrypoint.
 *
 * Composes three services:
 *   1. Hocuspocus WebSocket relay (content-opaque CRDT relay + snapshot persistence).
 *   2. Blob HTTP endpoint (GET/PUT /blob/:sha256, content-addressed storage).
 *   3. Admin HTTP server (optional; own port, ZYNC_ADMIN_TOKEN).
 *
 * Auth: per-device tokens via a file-backed `TokenRegistry` (`verifyToken`), with a
 * `ZYNC_TOKEN` single-token fallback for the harness/dev. The admin server (own port,
 * `ZYNC_ADMIN_TOKEN`) manages device tokens at runtime.
 *
 * Exports `createServer(config)` for in-process use (transport-conformance tests).
 * The `main()` function reads config from env and is the Docker entrypoint.
 */

import * as http from "node:http";
import { readFileSync } from "node:fs";
import { createRelay } from "./relay.js";
import { createBlobHandler } from "./file-endpoint.js";
import { S3BlobStore } from "./s3-blobstore.js";
import type { BlobBackend } from "./file-endpoint.js";
import { createAdminHandler, buildStatusProvider } from "./admin.js";
import { TokenRegistry } from "./token-registry.js";

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** Hocuspocus WebSocket port (ZYNC_PORT, default 1234). */
  relayPort: number;
  /** Blob HTTP server port (ZYNC_BLOB_PORT, default 8080). */
  blobPort: number;
  /** Static token — fallback auth when no registry is provided (harness/tests). */
  token?: string;
  /** Directory for Yjs snapshot persistence (ZYNC_SNAPSHOT_DIR). */
  snapshotDir: string;
  /** Injectable blob backend. */
  blobBackend: BlobBackend;
  /**
   * HARNESS-ONLY blob GET latch (ms, ZYNC_BLOB_GET_DELAY_MS). When > 0, every blob GET sleeps
   * this long + a `/_blob-stats` peak-concurrency route is exposed (see createBlobHandler). 0 in
   * production — no delay, no extra route. Used by the blob-scale gate to widen + measure the
   * prose-converges-before-blobs-settle decoupling window.
   */
  blobGetDelayMs?: number;
  /** Per-device token registry. When present it is the authoritative auth source. */
  registry?: TokenRegistry;
  /** Admin service config. Requires `registry`. Omit to disable the admin server. */
  admin?: { port: number; adminToken: string; uiHtml: string };
}

export interface ServerHandle {
  /** Gracefully shut down both the relay and the blob HTTP server. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// createServer — importable, in-process composition
// ---------------------------------------------------------------------------

export async function createServer(config: ServerConfig): Promise<ServerHandle> {
  const registry = config.registry;
  const verifyToken = registry ? (t: string) => registry.verify(t) : undefined;
  const getDevice = registry ? (t: string) => registry.getDevice(t) : undefined;

  // 1. Relay.
  const relay = createRelay({
    port: config.relayPort,
    snapshotDir: config.snapshotDir,
    ...(config.token !== undefined ? { token: config.token } : {}),
    ...(verifyToken ? { verifyToken } : {}),
    ...(getDevice ? { getDevice } : {}),
  });
  await relay.hocuspocus.listen();
  console.log(`[zync] relay on ws://0.0.0.0:${config.relayPort}`);

  // 2. Blob HTTP server (create eagerly — construction can't fail — so it's a definite const).
  const blobHandler = createBlobHandler(config.blobBackend, {
    ...(config.token !== undefined ? { token: config.token } : {}),
    ...(verifyToken ? { verifyToken } : {}),
    getDelayMs: config.blobGetDelayMs ?? 0,
  });
  const blobServer = http.createServer(blobHandler);
  let adminServer: http.Server | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      blobServer.on("error", reject);
      blobServer.listen(config.blobPort, () => {
        console.log(`[zync] blob  on http://0.0.0.0:${config.blobPort}`);
        resolve();
      });
    });

    // 3. Admin HTTP server (optional; requires a registry).
    if (config.admin && registry) {
      const status = buildStatusProvider({
        registry,
        blobBackend: config.blobBackend,
        snapshotDir: config.snapshotDir,
        startedAt: Date.now(),
      });
      const adminHandler = createAdminHandler({
        registry,
        adminToken: config.admin.adminToken,
        status,
        uiHtml: config.admin.uiHtml,
      });
      const created = http.createServer(adminHandler);
      adminServer = created;
      const adminPort = config.admin.port;
      await new Promise<void>((resolve, reject) => {
        created.on("error", reject);
        created.listen(adminPort, () => {
          console.log(`[zync] admin on http://0.0.0.0:${adminPort}`);
          resolve();
        });
      });
    }
  } catch (err) {
    // A server failed to bind after the relay already started. Tear down everything
    // already listening so createServer never leaks sockets, then rethrow.
    const as = adminServer;
    as?.closeAllConnections();
    blobServer.closeAllConnections();
    await Promise.allSettled([
      relay.close(),
      new Promise<void>((resolve, reject) => blobServer.close((e) => (e ? reject(e) : resolve()))),
      as
        ? new Promise<void>((resolve, reject) => as.close((e) => (e ? reject(e) : resolve())))
        : Promise.resolve(),
    ]);
    registry?.close();
    throw err;
  }

  return {
    async close() {
      const as = adminServer;
      blobServer.closeAllConnections();
      as?.closeAllConnections();
      await Promise.all([
        relay.close(),
        new Promise<void>((resolve, reject) =>
          blobServer.close((e) => (e ? reject(e) : resolve())),
        ),
        as
          ? new Promise<void>((resolve, reject) => as.close((e) => (e ? reject(e) : resolve())))
          : Promise.resolve(),
      ]);
      registry?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// main — Docker/process entrypoint driven by env vars
// ---------------------------------------------------------------------------

/** Parse+validate a port env var; throws on a non-integer or out-of-range value. */
function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
    throw new Error(`[zync] invalid ${name}: "${value}" (expected an integer 1-65535)`);
  }
  return n;
}

/**
 * Fail-closed startup guard. In single-token mode a missing/empty ZYNC_TOKEN
 * would otherwise yield an open relay ("" === "") or a useless always-reject
 * server; an empty ZYNC_ADMIN_TOKEN would start an admin server that locks
 * itself out. Production runs file mode (ZYNC_TOKENS_FILE), so these only bite
 * a misconfiguration — and now they bite loudly at startup instead of silently.
 */
export function assertAuthConfig(
  mode: "file" | "single",
  staticToken: string | undefined,
  adminToken: string | undefined,
): void {
  if (mode === "single" && (staticToken === undefined || staticToken === "")) {
    throw new Error(
      "[zync] no auth configured: set ZYNC_TOKENS_FILE (per-device tokens, recommended) or a non-empty ZYNC_TOKEN",
    );
  }
  if (adminToken === "") {
    throw new Error(
      "[zync] ZYNC_ADMIN_TOKEN is empty: unset it to disable the admin server, or set a strong token",
    );
  }
}

async function main(): Promise<void> {
  const relayPort = parsePort(process.env.ZYNC_PORT, 1234, "ZYNC_PORT");
  const blobPort = parsePort(process.env.ZYNC_BLOB_PORT, 8080, "ZYNC_BLOB_PORT");
  const adminPort = parsePort(process.env.ZYNC_ADMIN_PORT, 9090, "ZYNC_ADMIN_PORT");
  const staticToken = process.env.ZYNC_TOKEN;
  const tokensFile = process.env.ZYNC_TOKENS_FILE;
  const adminToken = process.env.ZYNC_ADMIN_TOKEN;
  const snapshotDir = process.env.ZYNC_SNAPSHOT_DIR ?? "/data/snapshots";
  // HARNESS-ONLY: 0 in production (no latch, no /_blob-stats). The blob-scale gate sets it.
  const blobGetDelayMs = Number(process.env.ZYNC_BLOB_GET_DELAY_MS ?? 0);

  const registry = TokenRegistry.create({
    ...(tokensFile !== undefined ? { tokensFile } : {}),
    ...(staticToken !== undefined ? { staticToken } : {}),
  });
  if (registry.mode === "file") registry.watch();
  console.log(`[zync] token registry: ${registry.mode} mode (${registry.deviceCount} devices)`);

  // Fail loud on a misconfigured auth setup before we bind any sockets.
  assertAuthConfig(registry.mode, staticToken, adminToken);

  let admin: { port: number; adminToken: string; uiHtml: string } | undefined;
  if (adminToken !== undefined) {
    const uiHtml = readFileSync(new URL("./admin-ui.html", import.meta.url), "utf8");
    admin = { port: adminPort, adminToken, uiHtml };
  }

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
    snapshotDir,
    blobBackend,
    blobGetDelayMs,
    registry,
    ...(admin !== undefined ? { admin } : {}),
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
