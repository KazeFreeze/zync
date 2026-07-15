/**
 * token-registry.ts — file-backed per-device token registry for @zync/server.
 *
 * Two modes, keyed on whether `tokensFile` is provided:
 *   - file mode: `tokens.json` is the authoritative auth source (hot-reloads,
 *     atomic writes). Used in production. An absent file = empty registry;
 *     add() creates it. A corrupt file at startup is fail-closed (throws).
 *   - single mode (no `tokensFile`): verify(t) = (t === staticToken). Keeps the
 *     harness/dev + existing tests unchanged (they pass ZYNC_TOKEN, no file).
 *
 * This is @zync/server (NOT @zync/core) — Node APIs + crypto are fine here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface DeviceToken {
  id: string;
  token: string;
  device: string;
  created: string;
}
export interface DeviceTokenPublic {
  id: string;
  device: string;
  created: string;
  tokenMasked: string;
}
export interface TokenRegistryOptions {
  /** Path to tokens.json. When set → file mode; when omitted → single-token mode. */
  tokensFile?: string;
  /** Static token for single-token (fallback) mode. */
  staticToken?: string;
  /** Injectable clock (ISO string) — defaults to Date. Tests override. */
  now?: () => string;
  /** Injectable token generator — defaults to 32 random bytes hex. Tests override. */
  genToken?: () => string;
  /** Injectable id generator — defaults to 8 random bytes hex. Tests override. */
  genId?: () => string;
}

function maskToken(token: string): string {
  return "…" + token.slice(-5);
}

/** Structural guard: a valid on-disk entry is an object with 4 string fields. */
function isDeviceToken(value: unknown): value is DeviceToken {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.token === "string" &&
    typeof e.device === "string" &&
    typeof e.created === "string"
  );
}

export class TokenRegistry {
  readonly mode: "file" | "single";
  private readonly tokensFile: string | undefined;
  private readonly staticToken: string | undefined;
  private readonly now: () => string;
  private readonly genToken: () => string;
  private readonly genId: () => string;
  private entries: DeviceToken[] = [];
  private byToken = new Map<string, DeviceToken>();
  private watcher: fs.FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;

  private constructor(opts: TokenRegistryOptions) {
    this.tokensFile = opts.tokensFile;
    this.staticToken = opts.staticToken;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.genToken = opts.genToken ?? (() => randomBytes(32).toString("hex"));
    this.genId = opts.genId ?? (() => randomBytes(8).toString("hex"));
    this.mode = opts.tokensFile ? "file" : "single";
  }

  static create(opts: TokenRegistryOptions): TokenRegistry {
    const reg = new TokenRegistry(opts);
    if (reg.mode === "file") reg.loadFromDiskOrThrow();
    return reg;
  }

  get deviceCount(): number {
    return this.mode === "file" ? this.entries.length : 0;
  }

  verify(token: string): boolean {
    if (this.mode === "single") return token === this.staticToken;
    return this.byToken.has(token);
  }

  getDevice(token: string): string | undefined {
    if (this.mode === "single") return token === this.staticToken ? "relay" : undefined;
    return this.byToken.get(token)?.device;
  }

  list(): DeviceTokenPublic[] {
    return this.entries.map((e) => ({
      id: e.id,
      device: e.device,
      created: e.created,
      tokenMasked: maskToken(e.token),
    }));
  }

  /**
   * Mint a new device token. `device` is a free-text label, not a unique key —
   * duplicate device names are allowed (each add mints a distinct token/id).
   */
  add(device: string): DeviceToken {
    this.assertFileMode();
    // Call genToken() BEFORE genId() — deterministic test generators share a
    // counter that genToken() increments and genId() reads.
    const token = this.genToken();
    const id = this.genId();
    const entry: DeviceToken = { id, token, device, created: this.now() };
    this.entries.push(entry);
    this.reindex();
    this.persist();
    return entry;
  }

  remove(id: string): boolean {
    this.assertFileMode();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    const removed = this.entries.length < before;
    if (removed) {
      this.reindex();
      this.persist();
    }
    return removed;
  }

  /** Start watching the file for EXTERNAL edits (operator-edited tokens.json). */
  watch(): void {
    const file = this.tokensFile;
    if (this.mode !== "file" || this.watcher || !file) return;
    const dir = path.dirname(file);
    const base = path.basename(file);
    this.watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== null && filename !== base) return;
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reloadSafe(), 200);
    });
  }

  close(): void {
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  // --- internals ---

  private assertFileMode(): void {
    if (this.mode !== "file") throw new Error("TokenRegistry: registry file not configured");
  }

  private reindex(): void {
    this.byToken = new Map(this.entries.map((e) => [e.token, e]));
  }

  private loadFromDiskOrThrow(): void {
    const file = this.tokensFile;
    if (!file) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries = [];
        this.reindex();
        return;
      }
      throw err;
    }
    this.entries = this.parseOrThrow(raw);
    this.reindex();
  }

  private parseOrThrow(raw: string): DeviceToken[] {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`TokenRegistry: tokens.json is not valid JSON (${this.tokensFile})`);
    }
    if (!Array.isArray(data))
      throw new Error(`TokenRegistry: tokens.json must be an array (${this.tokensFile})`);
    for (const el of data) {
      if (!isDeviceToken(el))
        throw new Error(
          `TokenRegistry: tokens.json has a malformed entry — each must be an object with string id/token/device/created (${this.tokensFile})`,
        );
    }
    return data as DeviceToken[];
  }

  /** Reload on external change; on error keep last-good + log (never throw/crash). */
  private reloadSafe(): void {
    const file = this.tokensFile;
    if (!file) return;
    try {
      const raw = fs.readFileSync(file, "utf8");
      this.entries = this.parseOrThrow(raw);
      this.reindex();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries = [];
        this.reindex();
        return;
      }
      console.error(`[zync-tokens] reload failed, keeping last-good set: ${String(err)}`);
    }
  }

  /**
   * Atomic durable write: temp → fsync(temp) → rename → fsync(dir).
   * Mirrors snapshot.ts `atomicWriteBytes` durability bar (fsync the file so its
   * bytes hit disk, fsync the parent dir so the rename entry survives a crash),
   * using sync calls since persist() is sync.
   */
  private persist(): void {
    const file = this.tokensFile;
    if (!file) return;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.tokens-tmp-${randomBytes(6).toString("hex")}`);
    const body = JSON.stringify(this.entries, null, 2);
    try {
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}
