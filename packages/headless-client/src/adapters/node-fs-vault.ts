/**
 * NodeFsVault — VaultPort implementation over node:fs/promises.
 *
 * Design decisions:
 * - Temp files are named `.zync-tmp-<random>` in the same directory as the target;
 *   same-directory ensures the rename is atomic on POSIX (same filesystem).
 * - The watcher fires for external writes only; the engine's echo-suppression layer
 *   (EchoLedger) handles deduplication of engine-origin events.
 * - Paths under `.obsidian/zync/` are excluded from both `list()` and watcher events.
 * - Duplicate raw watcher events for the same path are coalesced within 20 ms.
 */

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { VaultEvent, VaultPath, VaultPort, Unsubscribe } from "@zync/core";
import { TMP_PREFIX, isEnoent, atomicWriteBytes } from "./fs-utils.js";

const ZYNC_INTERNAL_PREFIX = ".obsidian/zync/";

function isExcluded(rel: string): boolean {
  return rel.startsWith(ZYNC_INTERNAL_PREFIX) || path.basename(rel).startsWith(TMP_PREFIX);
}

function toVaultPath(rel: string): VaultPath {
  // Normalise OS path separators to forward-slash so paths are portable.
  return rel.split(path.sep).join("/") as VaultPath;
}

export class NodeFsVault implements VaultPort {
  private readonly root: string;
  private readonly listeners = new Set<(e: VaultEvent) => void>();
  private watcher: fs.FSWatcher | null = null;
  /** Coalesce timer per path (deduplicate rapid duplicate events). */
  private readonly coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private readonly durabilityTrustedFlag: boolean;

  /**
   * @param root vault root directory.
   * @param opts.durabilityTrusted Whether the engine may TRUST an "absent at bootstrap" signal from
   *   this root enough to auto-propagate a closed-app delete (see {@link durabilityTrusted}). Defaults
   *   to `true` (a real local FS: fsync-grade atomic writes + a complete directory walk). Set `false`
   *   for FUSE / cloud-mounted roots (Dropbox, gocryptfs, network shares) where an absent file may be a
   *   not-yet-synced placeholder rather than a durable deletion — closed-app deletes are then held for
   *   one-tap confirmation instead.
   */
  constructor(root: string, opts?: { durabilityTrusted?: boolean }) {
    this.root = path.resolve(root);
    this.durabilityTrustedFlag = opts?.durabilityTrusted ?? true;
    this.startWatcher();
  }

  // ---------------------------------------------------------------------------
  // VaultPort implementation
  // ---------------------------------------------------------------------------

  async read(vaultPath: VaultPath): Promise<Uint8Array | null> {
    const abs = this.abs(vaultPath);
    try {
      const buf = await fsp.readFile(abs);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async writeAtomic(
    vaultPath: VaultPath,
    data: Uint8Array,
    opts?: { mtime?: number },
  ): Promise<void> {
    const abs = this.abs(vaultPath);
    const dir = path.dirname(abs);
    await fsp.mkdir(dir, { recursive: true });

    await atomicWriteBytes(abs, data);

    // Apply mtime after the atomic write — this is adapter-specific (the vault
    // port exposes mtime control; the shared helper intentionally does not).
    if (opts?.mtime !== undefined) {
      const mtimeSec = opts.mtime / 1000;
      await fsp.utimes(abs, mtimeSec, mtimeSec);
    }
  }

  async remove(vaultPath: VaultPath): Promise<void> {
    let existed = true;
    try {
      await fsp.unlink(this.abs(vaultPath));
    } catch (err) {
      if (isEnoent(err)) {
        existed = false;
      } else {
        throw err;
      }
    }
    // Emit a synthetic `delete` event SYNCHRONOUSLY (mirrors `rename`) so a caller can
    // await `remove` and KNOW the engine observed the deletion — without depending on the
    // ASYNC, coalesced, occasionally-LOSSY recursive `fs.watch` (which, under an event
    // burst, can drop the unlink or mis-probe it as a `modify`, leaving an engine-driven
    // flush to RESURRECT the just-deleted file before the watcher ever reports it). The
    // engine's `onDelete` is idempotent (an already-tombstoned entry early-returns), so the
    // later real watcher `delete` for the same path — if it does arrive — is a harmless
    // no-op. Only emit when the file actually existed (an ENOENT remove is a true no-op).
    if (existed) this.emit({ type: "delete", path: vaultPath });
  }

  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    // Contract: no-op (no error) when the source path does not exist, matching
    // FakeVault.rename behaviour so engine code behaves identically on real FS
    // and in unit tests.
    const absFrom = this.abs(from);
    const absTo = this.abs(to);
    await fsp.mkdir(path.dirname(absTo), { recursive: true });
    try {
      await fsp.rename(absFrom, absTo);
    } catch (err) {
      if (isEnoent(err)) return; // source missing → no-op
      throw err;
    }
    // Emit rename event synchronously so callers can await and know it fired.
    this.emit({ type: "rename", path: to, oldPath: from });
  }

  async list(prefix?: VaultPath): Promise<{ path: VaultPath; size: number; mtime: number }[]> {
    const results: { path: VaultPath; size: number; mtime: number }[] = [];
    await this.walk(this.root, this.root, prefix, results);
    return results;
  }

  onEvent(cb: (e: VaultEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  durabilityTrusted(): boolean {
    return this.durabilityTrustedFlag;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private abs(vaultPath: VaultPath): string {
    // Guard: never allow paths to escape root.
    const joined = path.join(this.root, vaultPath);
    if (!joined.startsWith(this.root + path.sep) && joined !== this.root) {
      throw new Error(`VaultPath escapes root: ${vaultPath}`);
    }
    return joined;
  }

  private emit(e: VaultEvent): void {
    // Do not emit after close() — an in-flight fs.stat callback that races
    // with close() must not fire events at an already-shut-down engine.
    if (this.closed) return;
    for (const l of this.listeners) l(e);
  }

  private async walk(
    absDir: string,
    rootDir: string,
    prefix: VaultPath | undefined,
    results: { path: VaultPath; size: number; mtime: number }[],
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const absEntry = path.join(absDir, entry.name);
      const rel = toVaultPath(path.relative(rootDir, absEntry));
      if (isExcluded(rel)) continue;
      if (entry.isDirectory()) {
        await this.walk(absEntry, rootDir, prefix, results);
      } else if (entry.isFile()) {
        if (prefix !== undefined && !rel.startsWith(prefix)) continue;
        const stat = await fsp.stat(absEntry);
        results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs });
      }
    }
  }

  private startWatcher(): void {
    // Node 22 recursive watch on Linux
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (eventType, filename) => {
        if (filename === null) return;
        const rel = toVaultPath(filename);
        if (isExcluded(rel)) return;

        // Coalesce duplicate events for the same path within 20 ms.
        const existing = this.coalesceTimers.get(rel);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.coalesceTimers.delete(rel);
          // Determine event type by probing the filesystem.
          const abs = path.join(this.root, filename);
          fs.stat(abs, (err, stat) => {
            if (err != null) {
              this.emit({ type: "delete", path: rel });
            } else if (stat.isFile()) {
              // We can't reliably distinguish create from modify here, so always
              // emit modify; the engine's echo-suppression handles the rest.
              this.emit({ type: "modify", path: rel });
            }
          });
        }, 20);
        this.coalesceTimers.set(rel, timer);
      });
    } catch {
      // Watcher is best-effort; tests that need external events use it,
      // but if the OS doesn't support recursive watch we degrade gracefully.
      this.watcher = null;
    }
  }

  /** Close the watcher (call when the vault is no longer needed). */
  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.coalesceTimers.values()) clearTimeout(t);
    this.coalesceTimers.clear();
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export async function makeTmpVault(): Promise<{ vault: NodeFsVault; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-vault-"));
  return { vault: new NodeFsVault(dir), dir };
}
