/**
 * Headless-client daemon (0b-3 Task 1b).
 *
 * `createDaemon(config)` constructs the REAL {@link SyncEngine} wired from the four FS/HTTP
 * adapters + the Yjs CRDT provider + Hocuspocus transport, plus the `node:http` control API
 * server — but boots IDLE: it does NOT call `engine.start()` until `POST /sync/start`. This
 * is fully testable in-process (point the adapters at temp dirs, run the transport offline)
 * so the control API can be exercised via `fetch` against an ephemeral port without a relay.
 *
 * The thin entrypoint at the bottom reads config from env and `listen`s on `ZYNC_PORT`
 * (default 7070) when this module is the process entrypoint.
 */

import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SyncEngine } from "@zync/core";
import type {
  BlobFetchPolicy,
  ClockPort,
  ConnStatus,
  DeviceId,
  IdentityPort,
  VaultEvent,
} from "@zync/core";
import { YjsCrdtProvider, HocuspocusTransport } from "@zync/crdt-yjs";
import { HttpBlobStore } from "@zync/blob-http";
import { NodeFsVault } from "./adapters/node-fs-vault.js";
import { NodeFsConfig } from "./adapters/node-fs-config.js";
import { FsDocStore } from "./adapters/fs-docstore.js";
import { FsEngineStateStore } from "./adapters/fs-engine-state.js";
import { createControlApi, type DaemonState } from "./control-api.js";

/** Daemon configuration. Env-derived in {@link configFromEnv}; explicit in tests. */
export interface DaemonConfig {
  vaultDir: string;
  /**
   * The ABSOLUTE `.obsidian/zync` base/state dir on the host FS (default
   * `<vaultDir>/.obsidian/zync`). The docstore + engine-state file live under it.
   */
  configDir: string;
  /**
   * The engine's `EngineConfig.configDir` — a VAULT-RELATIVE prefix the {@link BaseStore}
   * writes per-note base records under (`<engineConfigDir>/zync/base/<docId>.json`,
   * via the vault port). MUST be `.obsidian/zync` (vault-relative) so base files land
   * inside the `.obsidian/zync/` zone NodeFsVault excludes from `list()`/the watcher —
   * otherwise the base records would leak into `/fs/tree` and re-trigger ingest. This is
   * DISTINCT from {@link configDir} (an absolute host path); the engine never resolves
   * it on the host FS — only through the vault.
   */
  engineConfigDir: string;
  /** ABSOLUTE directory for the FsDocStore (CRDT snapshots). Default `<configDir>/docstore`. */
  docStoreDir: string;
  /** ABSOLUTE file path for the FsEngineStateStore JSON. Default `<configDir>/engine-state.json`. */
  stateFile: string;
  /** Root holding fixtures `/vault/load` copies from. Default `/fixtures`. */
  fixturesDir: string;
  deviceId: string;
  deviceName: string;
  /** Relay WebSocket URL for the HocuspocusTransport. */
  serverWs: string;
  /** Base URL for the HTTP blob store. */
  serverHttp: string;
  /** Static shared auth token (ZYNC_TOKEN) — sent to the relay AND the blob endpoint. */
  token?: string;
  port: number;
  maxProseBytes: number;
  /** Projector mode — the engine will not ingest local writes (Part C). */
  ingestDisabled: boolean;
  /**
   * Blob fetch policy (0b-3 Fix 3). `"eager"` (the headless-follower default) materializes
   * a synced blob onto disk as soon as its manifest entry replicates — without it a blob
   * reaches the server store but NEVER lands on the follower. `"lazy"` stays manifest-only
   * (fetch-on-open). Optional: the engine itself defaults to `"lazy"` when unset, so the
   * follower's eager default is set here in {@link configFromEnv}.
   */
  blobPolicy?: BlobFetchPolicy;
  /**
   * Whether the engine may TRUST this root's "absent at bootstrap" signal enough to auto-propagate a
   * closed-app delete (see {@link NodeFsVault.durabilityTrusted}). Omitted ⇒ the NodeFsVault default
   * (`true`, a real local FS). Set `false` for a FUSE / cloud-mounted vault (Dropbox, gocryptfs, network
   * share) — there an absent file may be a not-yet-synced placeholder, so deletes are held for confirm.
   */
  durabilityTrusted?: boolean;
  /**
   * Open a real socket. `false` for in-process offline tests so `start()` runs fully
   * offline and bootstrap seeds locally (no relay needed).
   */
  connect: boolean;
}

/** A constructed, idle daemon. Call {@link Daemon.listen} (entrypoint) or hit `handler`. */
export interface Daemon {
  readonly engine: SyncEngine;
  readonly vault: NodeFsVault;
  readonly transport: HocuspocusTransport;
  readonly state: DaemonState;
  readonly handler: http.RequestListener;
  readonly config: DaemonConfig;
  /** Start the HTTP server listening on `config.port`; resolves to the bound port. */
  listen(): Promise<number>;
  /** Stop the engine (if started), close the HTTP server, transport, and vault watcher. */
  close(): Promise<void>;
}

const DEFAULT_MAX_PROSE_BYTES = 1_000_000;

/**
 * Construct the engine + adapters + control-API server. Boots IDLE (no `engine.start()`
 * until `POST /sync/start`). The transport is constructed with `connect: config.connect`
 * so in-process tests can run fully offline.
 */
export async function createDaemon(config: DaemonConfig): Promise<Daemon> {
  // Only pass the option when set so the NodeFsVault default (true) applies otherwise — and so an
  // explicit `undefined` is never passed under exactOptionalPropertyTypes.
  const vault = new NodeFsVault(
    config.vaultDir,
    config.durabilityTrusted !== undefined
      ? { durabilityTrusted: config.durabilityTrusted }
      : undefined,
  );
  const configPort = new NodeFsConfig(config.vaultDir);
  const docStore = new FsDocStore(config.docStoreDir);
  const engineState = await FsEngineStateStore.open(config.stateFile);
  const blobs = new HttpBlobStore(config.serverHttp, config.token);
  const crdt = new YjsCrdtProvider();
  const transport = new HocuspocusTransport({
    url: config.serverWs,
    ...(config.token !== undefined ? { token: config.token } : {}),
    connect: config.connect,
  });

  const clock: ClockPort = { now: () => Date.now() };
  const deviceId = config.deviceId as DeviceId;
  const identity: IdentityPort = {
    deviceId: () => deviceId,
    deviceName: () => config.deviceName,
  };

  const engine = new SyncEngine(
    { vault, crdt, transport, blobs, docStore, clock, identity, engineState, config: configPort },
    {
      configDir: config.engineConfigDir,
      maxProseBytes: config.maxProseBytes,
      ingestDisabled: config.ingestDisabled,
      // Wire the blob fetch policy end-to-end (0b-3 Fix 3) so a synced blob materializes
      // onto this follower's disk. Only pass it when set so the engine's own default applies.
      ...(config.blobPolicy !== undefined ? { blobPolicy: config.blobPolicy } : {}),
      // Harness daemon: both categories always on so all config-themes/config-conflict
      // scenarios run unaffected. A per-device env-based toggle can be added later.
      configCategories: { themes: true, snippets: true },
    },
  );

  // ── observability counters ───────────────────────────────────────────────
  const state: DaemonState = {
    ingestCount: 0,
    writeCount: 0,
    lastSyncAt: null,
    editors: new Map(),
  };

  // The daemon subscribes its OWN vault listener (multiple listeners are supported) to
  // count external file-change events the engine actually INGESTED. Only incremented when
  // ingest is enabled (i.e. NOT in projector/ingestDisabled mode); in projector mode the
  // engine's onWrite early-returns, so no ingest happens and the counter must stay 0.
  // This is independent of the engine's own subscription — it only observes, never mutates.
  const vaultUnsub = vault.onEvent((e: VaultEvent) => {
    if ((e.type === "create" || e.type === "modify") && !config.ingestDisabled) {
      state.ingestCount += 1;
    }
  });

  // `lastSyncAt` = last wall-clock ms the transport became "connected". Stays null in
  // offline in-process tests (the transport never connects).
  const statusUnsub = transport.onStatus((s: ConnStatus) => {
    if (s === "connected") state.lastSyncAt = Date.now();
  });

  let started = false;
  const handler = createControlApi({
    engine,
    transport,
    vault,
    config: configPort,
    vaultDir: path.resolve(config.vaultDir),
    docStoreDir: path.resolve(config.docStoreDir),
    fixturesDir: path.resolve(config.fixturesDir),
    state,
    isStarted: () => started,
    setStarted: (v) => {
      started = v;
    },
  });

  let server: http.Server | null = null;

  return {
    engine,
    vault,
    transport,
    state,
    handler,
    config,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        const s = http.createServer(handler);
        server = s;
        s.on("error", reject);
        s.listen(config.port, () => {
          const addr = s.address();
          resolve(typeof addr === "object" && addr !== null ? addr.port : config.port);
        });
      }),
    close: async () => {
      vaultUnsub();
      statusUnsub();
      if (started) {
        await engine.stop();
        started = false;
      }
      await transport.close();
      vault.close();
      configPort.close();
      const s = server;
      if (s !== null) {
        await new Promise<void>((resolve, reject) => {
          s.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        server = null;
      }
    },
  };
}

// ── env entrypoint ─────────────────────────────────────────────────────────────

/** Build a {@link DaemonConfig} from environment variables with sane defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const vaultDir = env.ZYNC_VAULT_DIR ?? "/vault";
  const configDir = env.ZYNC_CONFIG_DIR ?? path.join(vaultDir, ".obsidian", "zync");
  return {
    vaultDir,
    configDir,
    // Vault-relative — base records must land inside the excluded `.obsidian/zync/` zone.
    engineConfigDir: env.ZYNC_ENGINE_CONFIG_DIR ?? ".obsidian/zync",
    docStoreDir: env.ZYNC_DOCSTORE_DIR ?? path.join(configDir, "docstore"),
    stateFile: env.ZYNC_STATE_FILE ?? path.join(configDir, "engine-state.json"),
    fixturesDir: env.ZYNC_FIXTURES_DIR ?? "/fixtures",
    deviceId: env.ZYNC_DEVICE_ID ?? "device-1",
    deviceName: env.ZYNC_DEVICE_NAME ?? "headless-device",
    serverWs: env.ZYNC_SERVER_WS ?? "ws://localhost:1234",
    serverHttp: env.ZYNC_SERVER_HTTP ?? "http://localhost:3000",
    ...(env.ZYNC_TOKEN !== undefined ? { token: env.ZYNC_TOKEN } : {}),
    port: env.ZYNC_PORT !== undefined ? Number(env.ZYNC_PORT) : 7070,
    maxProseBytes:
      env.ZYNC_MAX_PROSE_BYTES !== undefined
        ? Number(env.ZYNC_MAX_PROSE_BYTES)
        : DEFAULT_MAX_PROSE_BYTES,
    ingestDisabled: env.ZYNC_INGEST_DISABLED === "true" || env.ZYNC_INGEST_DISABLED === "1",
    // Follower default is EAGER (0b-3 Fix 3): synced blobs must land on disk, not just in
    // the server store. Only `"lazy"` opts out (fetch-on-open); any other value falls back
    // to eager so a typo never silently disables materialization.
    blobPolicy: env.ZYNC_BLOB_POLICY === "lazy" ? "lazy" : "eager",
    // Trust a real local root by default; only an explicit `false` opts out (FUSE/cloud mounts).
    durabilityTrusted: env.ZYNC_DURABILITY_TRUSTED !== "false",
    // The relay socket opens by default; tests override with `connect: false`.
    connect: env.ZYNC_CONNECT !== "false",
  };
}

/** Build the daemon from env and start listening. Used by the container entrypoint. */
export async function main(): Promise<void> {
  const config = configFromEnv();
  const daemon = await createDaemon(config);
  const port = await daemon.listen();
  console.log(`[zync-headless] listening on :${String(port)} (device=${config.deviceId})`);
}

// Run only when executed directly (not when imported by tests).
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  void main();
}
