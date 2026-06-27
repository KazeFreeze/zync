/**
 * ObsidianVaultPort — VaultPort implementation over the Obsidian App/Vault/DataAdapter APIs.
 *
 * The production counterpart of NodeFsVault; it mirrors that adapter's CONTRACT exactly
 * (same events, same `.obsidian/zync/` exclusion, same synchronous emit on remove/rename)
 * because the engine is validated against NodeFsVault. Design ratified by a GPT design-review
 * (this adapter cannot be run-tested without a real Obsidian runtime — fidelity of the real API
 * surface is the manual gate; the port-contract tests here cover routing/logic against a mock).
 *
 * Key decisions (see the M1-T1 plan):
 * - **Rename → `vault.rename` (pure move)**, NOT `fileManager.renameFile`. Engine-initiated renames
 *   must not re-synthesize backlink edits on the receiving device (the origin already syncs those as
 *   ordinary per-note content); `structural-reconcile` materializes remote renames as a pure move.
 * - **Write routing**: `.obsidian/zync/**` (the BaseStore dot-folder) → DataAdapter (the Vault API can't
 *   enumerate dot-folders); regular files → Vault API so Obsidian's model/events stay aware. Text vs binary
 *   is chosen by PATH/EXTENSION (prose: .md/.markdown/.txt), NOT by UTF-8 decodability (a structured file
 *   can be valid UTF-8 yet need byte-preserving routing).
 * - **mtime** is forwarded as `DataWriteOptions` (best-effort; a mobile adapter may round/ignore it —
 *   convergence is hash-based and must not depend on it).
 * - **Events**: forward `create|modify|delete|rename` filtered to `TFile`, excluding `.obsidian/zync/**`.
 *   Engine WRITE echoes are suppressed by the engine's EchoLedger (content hash). `remove()`/`rename()`
 *   additionally emit a SYNCHRONOUS structural event (matching NodeFsVault); the duplicate Obsidian echo is
 *   absorbed by engine idempotency (NO adapter-level path suppression).
 *
 * **Lifecycle (startup-create trap):** the vault event handlers are registered in the constructor, so the
 * plugin MUST construct this port inside `app.workspace.onLayoutReady(...)` — otherwise Obsidian's initial
 * file-inventory `create` storm on vault load would be ingested as user creates.
 *
 * `obsidian` is a types-only package (no runtime JS), so this module imports it as TYPES ONLY and uses a
 * duck-typed `isTFile` predicate instead of `instanceof` — which also makes it unit-testable with a mock.
 */

import type { DataWriteOptions, EventRef, TAbstractFile, TFile, Vault } from "obsidian";
import type { Unsubscribe, VaultEvent, VaultPath, VaultPort } from "@zync/core";

/** The base/config zone NodeFsVault excludes from list()/events; the BaseStore lives here. */
const ZYNC_INTERNAL_PREFIX = ".obsidian/zync/";

/** Extensions Zync writes as canonical UTF-8 text (prose). Everything else routes as binary. */
const PROSE_EXTENSIONS = new Set(["md", "markdown", "txt"]);

function isInternal(path: string): boolean {
  return path.startsWith(ZYNC_INTERNAL_PREFIX);
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function isProsePath(path: string): boolean {
  return PROSE_EXTENSIONS.has(extensionOf(path));
}

/**
 * Duck-typed `TFile` predicate — avoids `instanceof TFile` (the obsidian package is types-only, so the
 * class isn't available at runtime, and a mock can't be an instance of it). A `TFile` has a string
 * `extension`; a `TFolder` has a `children` array and no `extension`.
 */
function isTFile(f: TAbstractFile | null): f is TFile {
  return f !== null && typeof (f as Partial<TFile>).extension === "string";
}

/**
 * Copy a Uint8Array's exact bytes into a fresh ArrayBuffer (Obsidian's binary APIs take ArrayBuffer).
 * Assumes a non-shared backing buffer (the engine never produces SharedArrayBuffer-backed views).
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export class ObsidianVaultPort implements VaultPort {
  private readonly vault: Vault;
  private readonly listeners = new Set<(e: VaultEvent) => void>();
  private readonly eventRefs: EventRef[];
  private closed = false;

  constructor(vault: Vault) {
    this.vault = vault;
    // Register AFTER onLayoutReady (the plugin's responsibility — see class docstring) so Obsidian's
    // startup file-inventory `create` events are not ingested as user creates.
    this.eventRefs = [
      vault.on("create", (f) => {
        this.onFileEvent("create", f);
      }),
      vault.on("modify", (f) => {
        this.onFileEvent("modify", f);
      }),
      vault.on("delete", (f) => {
        this.onFileEvent("delete", f);
      }),
      vault.on("rename", (f, oldPath) => {
        this.onRenameEvent(f, oldPath);
      }),
    ];
  }

  // ---------------------------------------------------------------------------
  // VaultPort
  // ---------------------------------------------------------------------------

  async read(path: VaultPath): Promise<Uint8Array | null> {
    const adapter = this.vault.adapter;
    if (isInternal(path)) {
      if (!(await adapter.exists(path))) return null;
      return new Uint8Array(await adapter.readBinary(path));
    }
    const file = this.vault.getAbstractFileByPath(path);
    if (isTFile(file)) return new Uint8Array(await this.vault.readBinary(file));
    // No TFile yet (e.g. Obsidian hasn't indexed an external write) — fall back to the adapter for
    // current on-disk bytes (NOT cachedRead — the engine hashes disk truth).
    if (await adapter.exists(path)) return new Uint8Array(await adapter.readBinary(path));
    return null;
  }

  async writeAtomic(path: VaultPath, data: Uint8Array, opts?: { mtime?: number }): Promise<void> {
    const writeOpts: DataWriteOptions | undefined =
      opts?.mtime !== undefined ? { mtime: opts.mtime } : undefined;

    if (isInternal(path)) {
      // BaseStore zone — dot-folder, adapter only (the Vault API can't address it reliably).
      await this.ensureAdapterFolders(path);
      await this.vault.adapter.writeBinary(path, toArrayBuffer(data), writeOpts);
      return;
    }

    await this.ensureVaultFolders(path);
    const existing = this.vault.getAbstractFileByPath(path);

    if (isProsePath(path)) {
      const text = new TextDecoder().decode(data);
      if (isTFile(existing)) {
        // process() = atomic read-modify-write under Obsidian's write lock (safe vs the live editor).
        await this.vault.process(existing, () => text, writeOpts);
      } else {
        try {
          await this.vault.create(path, text, writeOpts);
        } catch {
          await this.overwrite(path, data, writeOpts);
        }
      }
    } else {
      const buf = toArrayBuffer(data);
      if (isTFile(existing)) {
        await this.vault.modifyBinary(existing, buf, writeOpts);
      } else {
        try {
          await this.vault.createBinary(path, buf, writeOpts);
        } catch {
          await this.overwrite(path, data, writeOpts);
        }
      }
    }
  }

  /**
   * Overwrite-safe fallback for the stale-cache race: `create`/`createBinary` reject when the file
   * exists on disk but isn't yet in Obsidian's tree. Re-resolve (it may be indexed now) and modify;
   * otherwise write through the adapter (idempotent overwrite) — matching NodeFsVault's unconditional
   * write, so `writeAtomic` never rejects merely because Obsidian's cache lagged the filesystem.
   */
  private async overwrite(
    path: VaultPath,
    data: Uint8Array,
    writeOpts: DataWriteOptions | undefined,
  ): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (isTFile(file)) {
      if (isProsePath(path)) {
        await this.vault.process(file, () => new TextDecoder().decode(data), writeOpts);
      } else {
        await this.vault.modifyBinary(file, toArrayBuffer(data), writeOpts);
      }
      return;
    }
    await this.vault.adapter.writeBinary(path, toArrayBuffer(data), writeOpts);
  }

  async remove(path: VaultPath): Promise<void> {
    let existed = true;
    if (isInternal(path)) {
      if (await this.vault.adapter.exists(path)) await this.vault.adapter.remove(path);
      else existed = false;
    } else {
      const file = this.vault.getAbstractFileByPath(path);
      if (isTFile(file)) await this.vault.delete(file);
      else if (await this.vault.adapter.exists(path)) await this.vault.adapter.remove(path);
      else existed = false;
    }
    // Synchronous synthetic delete (matches NodeFsVault) — a caller can await remove() and KNOW the engine
    // observed it. Obsidian's own delete echo (if any) is an idempotent no-op (onDelete early-returns for a
    // tombstoned/missing entry). Only emit when the file actually existed (ENOENT remove is a true no-op).
    if (existed) this.emit({ type: "delete", path });
  }

  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    if (isInternal(from)) {
      if (!(await this.vault.adapter.exists(from))) return; // source missing → no-op
      await this.ensureAdapterFolders(to);
      await this.vault.adapter.rename(from, to);
      this.emit({ type: "rename", path: to, oldPath: from });
      return;
    }
    const file = this.vault.getAbstractFileByPath(from);
    if (!isTFile(file)) return; // source missing → no-op (matches NodeFsVault)
    await this.ensureVaultFolders(to);
    // PURE move — NOT fileManager.renameFile (no backlink rewrite; see class docstring).
    await this.vault.rename(file, to);
    this.emit({ type: "rename", path: to, oldPath: from });
  }

  list(prefix?: VaultPath): Promise<{ path: VaultPath; size: number; mtime: number }[]> {
    // getFiles() returns vault-visible files (already excludes .obsidian/**); the isInternal guard is
    // belt-and-suspenders for the BaseStore zone. Synchronous in Obsidian — wrapped to satisfy the port.
    const out: { path: VaultPath; size: number; mtime: number }[] = [];
    for (const f of this.vault.getFiles()) {
      const path = f.path;
      if (isInternal(path)) continue;
      if (prefix !== undefined && !path.startsWith(prefix)) continue;
      out.push({ path: path as VaultPath, size: f.stat.size, mtime: f.stat.mtime });
    }
    return Promise.resolve(out);
  }

  onEvent(cb: (e: VaultEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  durabilityTrusted(): boolean {
    return false;
  }

  /** Detach all Obsidian event handlers + listeners. Call from the plugin's onunload. */
  close(): void {
    this.closed = true;
    for (const ref of this.eventRefs) this.vault.offref(ref);
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private emit(e: VaultEvent): void {
    if (this.closed) return;
    for (const l of this.listeners) l(e);
  }

  private onFileEvent(type: "create" | "modify" | "delete", f: TAbstractFile): void {
    if (!isTFile(f)) return; // drop TFolder events (M1 is per-file)
    if (isInternal(f.path)) return; // never ingest the BaseStore zone
    this.emit({ type, path: f.path as VaultPath });
  }

  private onRenameEvent(f: TAbstractFile, oldPath: string): void {
    if (!isTFile(f)) return;
    // A rename touching the BaseStore zone is internal mechanics, not a vault file change.
    if (isInternal(f.path) || isInternal(oldPath)) return;
    this.emit({ type: "rename", path: f.path as VaultPath, oldPath: oldPath as VaultPath });
  }

  /** Create missing ancestor folders for a regular vault path, top-down, idempotently. */
  private async ensureVaultFolders(path: string): Promise<void> {
    const segments = path.split("/");
    segments.pop(); // drop the filename
    let cur = "";
    for (const seg of segments) {
      cur = cur === "" ? seg : `${cur}/${seg}`;
      if (this.vault.getAbstractFileByPath(cur) === null) {
        try {
          await this.vault.createFolder(cur);
        } catch {
          // Folder already exists / created concurrently — ignore.
        }
      }
    }
  }

  /** Create missing ancestor folders for an adapter (dot-folder) path, top-down, idempotently. */
  private async ensureAdapterFolders(path: string): Promise<void> {
    const adapter = this.vault.adapter;
    const segments = path.split("/");
    segments.pop();
    let cur = "";
    for (const seg of segments) {
      cur = cur === "" ? seg : `${cur}/${seg}`;
      if (!(await adapter.exists(cur))) {
        try {
          await adapter.mkdir(cur);
        } catch {
          // Already exists / created concurrently — ignore.
        }
      }
    }
  }
}
