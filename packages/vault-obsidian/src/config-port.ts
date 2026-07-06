/**
 * ObsidianConfigPort — ConfigPort implementation over the Obsidian DataAdapter for the config zone
 * (`.obsidian/themes/` and `.obsidian/snippets/`). The Vault API cannot enumerate dot-folders, so
 * all IO goes through `vault.adapter` (DataAdapter) directly.
 *
 * Change detection is a best-effort two-layer approach:
 *  1. `vault.on("raw", cb)` — fires for any DataAdapter write Obsidian observes (not in official
 *     Obsidian types but present in every desktop/mobile build). Filtered to config zone paths
 *     only; self-exclusion guards `.obsidian/zync/**` and `.obsidian/plugins/zync/**` so the
 *     engine's own writes do not re-trigger it.
 *  2. A 30-second periodic rescan (`setInterval`) that diffs current zone file sha256s against
 *     the last-known shas, firing onChange for any changed (including deleted) paths. Catches
 *     changes missed by the watcher (e.g. external tool writes).
 *
 * Design ratified by the Phase-9 plan. On-device correctness (real `"raw"` event firing, real
 * DataAdapter behaviour) is the manual gate — unit tests run against the mock only.
 */

import type { EventRef, Vault } from "obsidian";
import type { ConfigPort, Unsubscribe, VaultPath } from "@zync/core";
import { CONFIG_ZONE_PREFIXES, isConfigZone } from "@zync/core";

/** Paths that are owned by Zync itself — never surface/act on writes here. */
const ZYNC_INTERNAL_PREFIX = ".obsidian/zync/";
const ZYNC_PLUGIN_PREFIX = ".obsidian/plugins/zync/";

/** How often (ms) to do a periodic full rescan of the config zone. */
const RESCAN_INTERVAL_MS = 30_000;

function isSelfExcluded(path: string): boolean {
  return path.startsWith(ZYNC_INTERNAL_PREFIX) || path.startsWith(ZYNC_PLUGIN_PREFIX);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Hex-encode a SHA-256 digest of `data` using the Web Crypto API. */
async function sha256hex(data: Uint8Array): Promise<string> {
  // toArrayBuffer produces a clean ArrayBuffer (slice) so SubtleCrypto's strict
  // BufferSource type is satisfied regardless of the Uint8Array's original backing buffer.
  const buf = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create missing ancestor folders for an adapter (dot-folder) path, top-down, idempotently. */
async function ensureAdapterFolders(vault: Vault, path: string): Promise<void> {
  const adapter = vault.adapter;
  const segments = path.split("/");
  segments.pop(); // drop filename
  let cur = "";
  for (const seg of segments) {
    cur = cur === "" ? seg : `${cur}/${seg}`;
    if (!(await adapter.exists(cur))) {
      try {
        await adapter.mkdir(cur);
      } catch {
        // Already exists or created concurrently — ignore.
      }
    }
  }
}

/**
 * A narrowly-typed interface for the subset of Vault we use for the "raw" watcher.
 * `vault.on("raw", cb)` is not in official Obsidian types but exists in every build.
 */
interface RawVault {
  on(name: "raw", cb: (path: string) => void): EventRef;
  offref(ref: EventRef): void;
}

export class ObsidianConfigPort implements ConfigPort {
  private readonly vault: Vault;
  private readonly listeners = new Set<(path: VaultPath) => void>();
  private readonly eventRefs: EventRef[] = [];
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  /** sha256hex snapshot from the last rescan, keyed by vault-relative path. */
  private lastShas = new Map<string, string>();

  constructor(vault: Vault) {
    this.vault = vault;

    // 1. "raw" watcher — DataAdapter events for all paths, filtered to our zone + exclusions.
    const rawRef = (vault as unknown as RawVault).on("raw", (path: string) => {
      if (isConfigZone(path as VaultPath) && !isSelfExcluded(path)) {
        this.fire(path as VaultPath);
      }
    });
    this.eventRefs.push(rawRef);

    // 2. Periodic rescan backstop (catches writes the watcher misses).
    this.rescanTimer = setInterval(() => {
      void this.doRescan();
    }, RESCAN_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // ConfigPort
  // ---------------------------------------------------------------------------

  async read(path: VaultPath): Promise<Uint8Array | null> {
    if (this.rejectReason(path) !== null) return null;
    const adapter = this.vault.adapter;
    if (!(await adapter.exists(path))) return null;
    return new Uint8Array(await adapter.readBinary(path));
  }

  async writeAtomic(path: VaultPath, data: Uint8Array): Promise<void> {
    const reason = this.rejectReason(path);
    if (reason === "traversal")
      throw new Error(`ObsidianConfigPort: path traversal rejected: ${path}`);
    if (reason === "out-of-zone") return;
    await ensureAdapterFolders(this.vault, path);
    await this.vault.adapter.writeBinary(path, toArrayBuffer(data));
  }

  async remove(path: VaultPath): Promise<void> {
    const reason = this.rejectReason(path);
    if (reason === "traversal")
      throw new Error(`ObsidianConfigPort: path traversal rejected: ${path}`);
    if (reason === "out-of-zone") return;
    const adapter = this.vault.adapter;
    if (await adapter.exists(path)) {
      await adapter.remove(path);
    }
  }

  /** List all config-zone files (recursively) under the two allow-listed prefixes. */
  async list(): Promise<{ path: VaultPath; size: number }[]> {
    const result: { path: VaultPath; size: number }[] = [];
    for (const prefix of CONFIG_ZONE_PREFIXES) {
      // Strip the trailing slash for adapter.list (it lists the directory itself).
      await this.collectFiles(prefix.slice(0, -1), result);
    }
    return result;
  }

  onChange(cb: (path: VaultPath) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async rescan(): Promise<void> {
    await this.doRescan();
  }

  close(): void {
    if (this.rescanTimer !== null) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    for (const ref of this.eventRefs) {
      (this.vault as unknown as RawVault).offref(ref);
    }
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Returns the rejection reason for a path, or null if the path is valid.
   *
   * "traversal" — path contains a `..` segment and must be rejected with an Error (mirrors the
   *   throw behaviour of `NodeFsConfig.abs()` when a path escapes the vault root).
   * "out-of-zone" — path is outside the config zone or self-excluded; callers should no-op
   *   (mirrors `NodeFsConfig.writeAtomic`'s silent early-return for out-of-zone paths).
   */
  private rejectReason(path: string): "traversal" | "out-of-zone" | null {
    // Check traversal first: any ".." segment is rejected regardless of zone.
    if (path.split("/").some((seg) => seg === "..")) return "traversal";
    // Reject paths outside the config zone or self-excluded (Zync internal files).
    if (!isConfigZone(path as VaultPath) || isSelfExcluded(path)) return "out-of-zone";
    return null;
  }

  private fire(path: VaultPath): void {
    for (const cb of this.listeners) cb(path);
  }

  /**
   * Recursively collect all files under `dir` into `out`, skipping self-excluded paths.
   * Uses `adapter.list` (which lists immediate children) then recurses into sub-folders.
   */
  private async collectFiles(dir: string, out: { path: VaultPath; size: number }[]): Promise<void> {
    let listed: { files: string[]; folders: string[] };
    try {
      listed = await this.vault.adapter.list(dir);
    } catch {
      return; // directory does not exist or is inaccessible — not an error
    }
    for (const filePath of listed.files) {
      if (isSelfExcluded(filePath)) continue;
      const stat = await this.vault.adapter.stat(filePath);
      if (stat !== null && stat.type === "file") {
        out.push({ path: filePath as VaultPath, size: stat.size });
      }
    }
    for (const folderPath of listed.folders) {
      await this.collectFiles(folderPath, out);
    }
  }

  /**
   * Diff current zone file sha256s against last-known; fire onChange for anything that changed
   * (new, modified, or deleted). Updates `lastShas` in place.
   */
  private async doRescan(): Promise<void> {
    const allFiles = await this.list();
    const newShas = new Map<string, string>();

    for (const { path } of allFiles) {
      try {
        const buf = await this.vault.adapter.readBinary(path);
        const sha = await sha256hex(new Uint8Array(buf));
        newShas.set(path, sha);
        const prev = this.lastShas.get(path);
        if (prev === undefined || prev !== sha) {
          this.fire(path);
        }
      } catch {
        // File disappeared mid-rescan — will be caught by the deletion sweep below.
      }
    }

    // Fire for paths that existed last scan but are now gone (deleted externally).
    for (const [path] of this.lastShas) {
      if (!newShas.has(path)) {
        this.fire(path as VaultPath);
      }
    }

    this.lastShas = newShas;
  }
}
