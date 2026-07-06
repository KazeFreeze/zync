/**
 * NodeFsConfig — ConfigPort implementation over node:fs/promises.
 *
 * Scopes ALL reads, writes, and listings to the config zone:
 * `.obsidian/themes/**` and `.obsidian/snippets/**`.
 *
 * Change detection is layered:
 *   1. `fs.watch` on `<root>/.obsidian` (recursive) — fires quickly for in-process writes.
 *      Started when `.obsidian` exists; ENOENT is silenced (the periodic rescan covers gaps).
 *   2. A 30 s `setInterval` rescan that diffs mtime+size vs the last-known snapshot and
 *      fires `onChange` callbacks for any changed/added/removed paths. This backstop catches
 *      changes that arrive while the watcher is absent AND is the only mechanism for detecting
 *      removals (fs.watch on Linux does not always fire for `unlink` inside a recursive watch).
 */

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ConfigPort, VaultPath, Unsubscribe } from "@zync/core";
import { CONFIG_ZONE_PREFIXES, isConfigZone } from "@zync/core";
import { TMP_PREFIX, isEnoent, atomicWriteBytes } from "./fs-utils.js";

/** Stat snapshot used by the periodic rescan to detect out-of-band changes. */
interface FileStat {
  mtime: number;
  size: number;
}

export class NodeFsConfig implements ConfigPort {
  private readonly root: string;
  private readonly cbs = new Set<(path: VaultPath) => void>();
  private watcher: fs.FSWatcher | null = null;
  private readonly scanTimer: ReturnType<typeof setInterval>;
  /** Last-known mtime+size per vault-relative path (used by rescan diff). */
  private lastKnown = new Map<string, FileStat>();
  private closed = false;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.startWatcher();
    this.scanTimer = setInterval(() => {
      void this.rescan();
    }, 30_000);
    // Unref so the interval does not prevent process exit.
    if (typeof (this.scanTimer as { unref?: () => void }).unref === "function") {
      (this.scanTimer as { unref: () => void }).unref();
    }
  }

  // ---------------------------------------------------------------------------
  // ConfigPort implementation
  // ---------------------------------------------------------------------------

  async read(vaultPath: VaultPath): Promise<Uint8Array | null> {
    if (!isConfigZone(vaultPath)) return null;
    const abs = this.abs(vaultPath);
    try {
      const buf = await fsp.readFile(abs);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async writeAtomic(vaultPath: VaultPath, data: Uint8Array): Promise<void> {
    if (!isConfigZone(vaultPath)) return;
    const abs = this.abs(vaultPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await atomicWriteBytes(abs, data);
  }

  async remove(vaultPath: VaultPath): Promise<void> {
    if (!isConfigZone(vaultPath)) return;
    try {
      await fsp.unlink(this.abs(vaultPath));
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }

  async list(): Promise<{ path: VaultPath; size: number }[]> {
    const results: { path: VaultPath; size: number }[] = [];
    for (const prefix of CONFIG_ZONE_PREFIXES) {
      const absDir = path.join(this.root, prefix);
      await this.walkDir(absDir, results);
    }
    return results;
  }

  onChange(cb: (path: VaultPath) => void): Unsubscribe {
    this.cbs.add(cb);
    return () => {
      this.cbs.delete(cb);
    };
  }

  async rescan(): Promise<void> {
    if (this.closed) return;
    // Walk all config zone files and snapshot mtime+size.
    const current = new Map<string, FileStat>();
    for (const prefix of CONFIG_ZONE_PREFIXES) {
      await this.scanDir(path.join(this.root, prefix), current);
    }

    // Diff against last-known: fire for changed/added.
    const fired = new Set<string>();
    for (const [rel, stat] of current) {
      const prev = this.lastKnown.get(rel);
      if (prev?.mtime !== stat.mtime || prev.size !== stat.size) {
        fired.add(rel);
      }
    }
    // Fire for removed paths.
    for (const rel of this.lastKnown.keys()) {
      if (!current.has(rel)) fired.add(rel);
    }

    this.lastKnown = current;

    for (const rel of fired) {
      this.fire(rel as VaultPath);
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.scanTimer);
    this.watcher?.close();
    this.watcher = null;
    this.cbs.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Guard: never allow paths to escape root or contain traversal segments. */
  private abs(vaultPath: VaultPath): string {
    // Reject ".." segments explicitly: path.join normalises them so a path like
    // ".obsidian/snippets/../../evil.css" would resolve to "${root}/evil.css" and
    // pass the startsWith check below while still escaping the config zone.
    if ((vaultPath as string).split("/").some((seg) => seg === "..")) {
      throw new Error(`VaultPath escapes root: ${vaultPath}`);
    }
    const joined = path.join(this.root, vaultPath);
    if (!joined.startsWith(this.root + path.sep) && joined !== this.root) {
      throw new Error(`VaultPath escapes root: ${vaultPath}`);
    }
    return joined;
  }

  private fire(vaultPath: VaultPath): void {
    if (this.closed) return;
    for (const cb of this.cbs) cb(vaultPath);
  }

  /**
   * Recursively walk `absDir`, appending `{path, size}` entries for every file.
   * ENOENT on the directory itself is silenced (the zone dir may not exist yet).
   */
  private async walkDir(
    absDir: string,
    results: { path: VaultPath; size: number }[],
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(TMP_PREFIX)) continue;
      const absEntry = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(absEntry, results);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(absEntry);
        const rel = path.relative(this.root, absEntry).split(path.sep).join("/") as VaultPath;
        results.push({ path: rel, size: stat.size });
      }
    }
  }

  /**
   * Snapshot mtime+size for every file under `absDir` into `out`.
   * ENOENT on the dir itself is silenced.
   */
  private async scanDir(absDir: string, out: Map<string, FileStat>): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(TMP_PREFIX)) continue;
      const absEntry = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await this.scanDir(absEntry, out);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(absEntry);
          const rel = path.relative(this.root, absEntry).split(path.sep).join("/");
          out.set(rel, { mtime: stat.mtimeMs, size: stat.size });
        } catch (err) {
          if (!isEnoent(err)) throw err;
          // File disappeared between readdir and stat — ignore.
        }
      }
    }
  }

  /**
   * Attempt to start a recursive `fs.watch` on `<root>/.obsidian`. Filters events to
   * the config zone prefixes. Silences ENOENT (the dir may not exist yet; the periodic
   * rescan covers that gap). Fires all registered `onChange` callbacks.
   */
  private startWatcher(): void {
    const obsidianDir = path.join(this.root, ".obsidian");
    try {
      this.watcher = fs.watch(obsidianDir, { recursive: true }, (_eventType, filename) => {
        if (filename === null) return;
        // `filename` is relative to the watched dir (`.obsidian`), so prepend it.
        const rel = `.obsidian/${filename.split(path.sep).join("/")}` as VaultPath;
        if (!isConfigZone(rel)) return;
        if (path.basename(filename).startsWith(TMP_PREFIX)) return;
        this.fire(rel);
      });
    } catch {
      // `.obsidian` does not exist yet — silently degrade to rescan-only.
      this.watcher = null;
    }
  }
}
