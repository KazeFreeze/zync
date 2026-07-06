/**
 * In-memory Obsidian `Vault` + `DataAdapter` test double for `ObsidianVaultPort` contract tests.
 *
 * Faithful to the behaviors the port depends on, NOT a full Obsidian emulation:
 * - One backing store for all file bytes; `.obsidian/**` paths are NOT surfaced as `TFile`s via the Vault
 *   tree (only the adapter addresses them) — matching how Obsidian hides config dot-folders.
 * - Port-facing methods (`create`/`process`/`modifyBinary`/`delete`/`rename`, and the adapter writes) mutate
 *   state SILENTLY — they do NOT fire vault events. Real Obsidian DOES fire events for plugin writes (handled
 *   by the engine's EchoLedger), but modeling that here would just duplicate the `external.*` forwarding path
 *   and obscure the synchronous-synthetic-emit contract. Use `external.*` to simulate user/external changes.
 * - `external.*` helpers mutate state AND fire the corresponding vault event synchronously.
 *
 * Cast to `Vault` via `as unknown as Vault` — it implements only the slice the port uses.
 */

import type { DataWriteOptions, EventRef, TAbstractFile, TFile, TFolder, Vault } from "obsidian";

interface FileRec {
  data: Uint8Array;
  mtime: number;
  ctime: number;
}

type VaultEventName = "create" | "modify" | "delete" | "rename" | "raw";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function isInternal(path: string): boolean {
  return path.startsWith(".obsidian/");
}

export interface MockVaultExternal {
  /** Simulate an external/user create (fires a `create` event). */
  create(path: string, data: string | Uint8Array): void;
  /** Simulate an external/user modify (fires a `modify` event). */
  modify(path: string, data: string | Uint8Array): void;
  /** Simulate an external/user delete (fires a `delete` event). */
  delete(path: string): void;
  /** Simulate an external/user rename (fires a `rename` event with oldPath). */
  rename(from: string, to: string): void;
  /** Fire a `create` event whose payload is a TFolder (to verify the port drops folder events). */
  folderCreate(path: string): void;
  /** Write bytes to "disk" WITHOUT indexing them in the Vault tree (models Obsidian's cache lag). */
  hiddenPut(path: string, data: string | Uint8Array): void;
  /** Inspect raw stored bytes (null if absent). */
  peek(path: string): Uint8Array | null;
  /**
   * Fire a `"raw"` vault event for `path` (simulates Obsidian's config-zone DataAdapter watcher).
   * Used to test ObsidianConfigPort.onChange filtering without writing to disk.
   */
  raw(path: string): void;
}

export interface MockVault {
  vault: Vault;
  external: MockVaultExternal;
}

export function createMockVault(): MockVault {
  const files = new Map<string, FileRec>();
  const folders = new Set<string>();
  // Paths present on "disk" but NOT yet surfaced in the Vault tree — models Obsidian's metadata-cache
  // lag after an external write (so getAbstractFileByPath returns null while the bytes exist).
  const hidden = new Set<string>();
  const handlers: Record<VaultEventName, Set<(...args: unknown[]) => unknown>> = {
    create: new Set(),
    modify: new Set(),
    delete: new Set(),
    rename: new Set(),
    raw: new Set(),
  };

  // Deterministic monotonic clock for default mtimes (explicit DataWriteOptions.mtime overrides it).
  let clock = 1_700_000_000_000;
  const nextTime = (): number => ++clock;

  const fire = (name: VaultEventName, ...args: unknown[]): void => {
    for (const cb of [...handlers[name]]) cb(...args);
  };

  const mkTFile = (path: string): TFile => {
    const rec = files.get(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    const ext = extOf(path);
    return {
      path,
      name,
      basename: ext === "" ? name : name.slice(0, name.length - ext.length - 1),
      extension: ext,
      stat: { size: rec?.data.byteLength ?? 0, mtime: rec?.mtime ?? 0, ctime: rec?.ctime ?? 0 },
    } as unknown as TFile;
  };

  const mkTFolder = (path: string): TFolder => {
    return {
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      children: [],
    } as unknown as TFolder;
  };

  const put = (path: string, data: Uint8Array, mtime?: number): void => {
    const prev = files.get(path);
    files.set(path, {
      data,
      mtime: mtime ?? nextTime(),
      ctime: prev?.ctime ?? nextTime(),
    });
  };

  const adapter = {
    exists: (path: string): Promise<boolean> =>
      Promise.resolve(files.has(path) || folders.has(path)),
    readBinary: (path: string): Promise<ArrayBuffer> => {
      const rec = files.get(path);
      if (rec === undefined) return Promise.reject(new Error(`absent: ${path}`));
      return Promise.resolve(toArrayBuffer(rec.data));
    },
    writeBinary: (path: string, data: ArrayBuffer, opts?: DataWriteOptions): Promise<void> => {
      put(path, new Uint8Array(data), opts?.mtime);
      return Promise.resolve();
    },
    write: (path: string, data: string, opts?: DataWriteOptions): Promise<void> => {
      put(path, enc(data), opts?.mtime);
      return Promise.resolve();
    },
    remove: (path: string): Promise<void> => {
      files.delete(path);
      return Promise.resolve();
    },
    rename: (from: string, to: string): Promise<void> => {
      const rec = files.get(from);
      if (rec !== undefined) {
        files.delete(from);
        files.set(to, rec);
      }
      return Promise.resolve();
    },
    mkdir: (path: string): Promise<void> => {
      folders.add(path);
      return Promise.resolve();
    },
    stat: (
      path: string,
    ): Promise<{ type: "file" | "folder"; mtime: number; ctime: number; size: number } | null> => {
      const rec = files.get(path);
      if (rec !== undefined)
        return Promise.resolve({
          type: "file",
          mtime: rec.mtime,
          ctime: rec.ctime,
          size: rec.data.byteLength,
        });
      if (folders.has(path))
        return Promise.resolve({ type: "folder", mtime: 0, ctime: 0, size: 0 });
      return Promise.resolve(null);
    },
    /**
     * List immediate children of `path`. Returns `{ files, folders }` where each entry is a
     * full vault-relative path. Matches the Obsidian DataAdapter.list contract.
     */
    list: (path: string): Promise<{ files: string[]; folders: string[] }> => {
      const prefix = `${path}/`;
      const fileList: string[] = [];
      const folderSet = new Set<string>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          fileList.push(filePath);
        } else {
          folderSet.add(`${prefix}${rest.slice(0, slash)}`);
        }
      }
      for (const folderPath of folders) {
        if (!folderPath.startsWith(prefix)) continue;
        const rest = folderPath.slice(prefix.length);
        if (!rest.includes("/")) folderSet.add(folderPath);
      }
      return Promise.resolve({ files: fileList, folders: [...folderSet] });
    },
  };

  const vault = {
    adapter,

    getAbstractFileByPath: (path: string): TAbstractFile | null => {
      if (folders.has(path)) return mkTFolder(path);
      if (files.has(path) && !isInternal(path) && !hidden.has(path)) return mkTFile(path);
      return null;
    },

    getFiles: (): TFile[] =>
      [...files.keys()].filter((p) => !isInternal(p) && !hidden.has(p)).map((p) => mkTFile(p)),

    readBinary: (file: TFile): Promise<ArrayBuffer> => {
      const rec = files.get(file.path);
      if (rec === undefined) return Promise.reject(new Error(`absent: ${file.path}`));
      return Promise.resolve(toArrayBuffer(rec.data));
    },

    create: (path: string, data: string, opts?: DataWriteOptions): Promise<TFile> => {
      // Real Obsidian rejects create() when the path already exists on disk (even if un-indexed).
      if (files.has(path)) return Promise.reject(new Error(`already exists: ${path}`));
      put(path, enc(data), opts?.mtime);
      return Promise.resolve(mkTFile(path));
    },

    createBinary: (path: string, data: ArrayBuffer, opts?: DataWriteOptions): Promise<TFile> => {
      if (files.has(path)) return Promise.reject(new Error(`already exists: ${path}`));
      put(path, new Uint8Array(data), opts?.mtime);
      return Promise.resolve(mkTFile(path));
    },

    process: (
      file: TFile,
      fn: (data: string) => string,
      opts?: DataWriteOptions,
    ): Promise<string> => {
      const rec = files.get(file.path);
      const cur = rec !== undefined ? dec(rec.data) : "";
      const next = fn(cur);
      put(file.path, enc(next), opts?.mtime);
      return Promise.resolve(next);
    },

    modifyBinary: (file: TFile, data: ArrayBuffer, opts?: DataWriteOptions): Promise<void> => {
      put(file.path, new Uint8Array(data), opts?.mtime);
      return Promise.resolve();
    },

    delete: (file: TAbstractFile): Promise<void> => {
      files.delete(file.path);
      return Promise.resolve();
    },

    rename: (file: TAbstractFile, newPath: string): Promise<void> => {
      const rec = files.get(file.path);
      if (rec !== undefined) {
        files.delete(file.path);
        files.set(newPath, rec);
      }
      return Promise.resolve();
    },

    createFolder: (path: string): Promise<TFolder> => {
      if (folders.has(path)) return Promise.reject(new Error(`folder exists: ${path}`));
      folders.add(path);
      return Promise.resolve(mkTFolder(path));
    },

    on: (name: VaultEventName, cb: (...args: unknown[]) => unknown): EventRef => {
      handlers[name].add(cb);
      return { _name: name, _cb: cb };
    },

    offref: (ref: EventRef): void => {
      const r = ref as unknown as { _name: VaultEventName; _cb: (...args: unknown[]) => unknown };
      handlers[r._name].delete(r._cb);
    },
  };

  const external: MockVaultExternal = {
    create: (path, data) => {
      put(path, typeof data === "string" ? enc(data) : data);
      fire("create", mkTFile(path));
    },
    modify: (path, data) => {
      put(path, typeof data === "string" ? enc(data) : data);
      fire("modify", mkTFile(path));
    },
    delete: (path) => {
      const f = mkTFile(path);
      files.delete(path);
      fire("delete", f);
    },
    rename: (from, to) => {
      const rec = files.get(from);
      if (rec !== undefined) {
        files.delete(from);
        files.set(to, rec);
      }
      fire("rename", mkTFile(to), from);
    },
    folderCreate: (path) => {
      folders.add(path);
      fire("create", mkTFolder(path));
    },
    hiddenPut: (path, data) => {
      put(path, typeof data === "string" ? enc(data) : data);
      hidden.add(path);
    },
    peek: (path) => files.get(path)?.data ?? null,
    raw: (path) => {
      fire("raw", path);
    },
  };

  return { vault: vault as unknown as Vault, external };
}
