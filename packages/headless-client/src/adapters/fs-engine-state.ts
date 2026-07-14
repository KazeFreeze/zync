/**
 * FsEngineStateStore — crash-survivable EngineStateStore backed by a single JSON file.
 *
 * Usage:
 *   const store = await FsEngineStateStore.open("/path/to/state.json");
 *
 * The factory loads the existing file (or starts with empty state if missing).
 * Every mutation atomically rewrites the file (temp + rename + parent-dir fsync)
 * so the state is always consistent on disk even after a SIGKILL mid-write.
 *
 * An in-memory copy is kept for synchronous reads — all public methods are
 * async to satisfy the EngineStateStore port interface.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { DocId, EngineStateStore, Sha256, Stamp, VaultPath } from "@zync/core";
import { isEnoent, atomicWriteBytes } from "./fs-utils.js";

interface StateFile {
  syncedStamps: Record<string, string>;
  dirty: string[];
  // M2 path-collision facets. Optional: pre-M2 state files on disk have no such
  // keys, so reads must default them — `persist()` always writes them going forward.
  lastLivePaths?: Record<string, string>;
  deleted?: string[];
  // Config base: last sha materialized from remote per config path. Optional for back-compat.
  configBases?: Record<string, string>;
  // plugin-data version-aware convergence: numeric edit-version of the on-disk value per config path.
  // Optional for back-compat (pre-tiebreak state files have no key → every path reads as version 0).
  configLocalVersions?: Record<string, number>;
  // Slice 2b: per-device suppress list. Optional for back-compat (pre-2b state files have no key).
  localSuppress?: string[];
}

export class FsEngineStateStore implements EngineStateStore {
  private readonly filePath: string;
  private syncedStamps: Map<DocId, Stamp>;
  private dirty: Set<DocId>;
  private lastLive: Map<DocId, VaultPath>;
  private deletedDocs: Set<DocId>;
  private configBasesMap: Map<VaultPath, Sha256>;
  private configLocalVersionsMap: Map<VaultPath, number>;
  private localSuppressArr: string[];

  private constructor(
    filePath: string,
    syncedStamps: Map<DocId, Stamp>,
    dirty: Set<DocId>,
    lastLive: Map<DocId, VaultPath>,
    deletedDocs: Set<DocId>,
    configBasesMap: Map<VaultPath, Sha256>,
    configLocalVersionsMap: Map<VaultPath, number>,
    localSuppressArr: string[],
  ) {
    this.filePath = filePath;
    this.syncedStamps = syncedStamps;
    this.dirty = dirty;
    this.lastLive = lastLive;
    this.deletedDocs = deletedDocs;
    this.configBasesMap = configBasesMap;
    this.configLocalVersionsMap = configLocalVersionsMap;
    this.localSuppressArr = localSuppressArr;
  }

  /** Async factory: loads existing state or starts fresh. */
  static async open(filePath: string): Promise<FsEngineStateStore> {
    const abs = path.resolve(filePath);
    const syncedStamps = new Map<DocId, Stamp>();
    const dirty = new Set<DocId>();
    const lastLive = new Map<DocId, VaultPath>();
    const deletedDocs = new Set<DocId>();
    const configBasesMap = new Map<VaultPath, Sha256>();
    const configLocalVersionsMap = new Map<VaultPath, number>();
    const localSuppressArr: string[] = [];
    try {
      const raw = await fsp.readFile(abs, "utf8");
      const data = JSON.parse(raw) as StateFile;
      for (const [k, v] of Object.entries(data.syncedStamps)) {
        syncedStamps.set(k as DocId, v);
      }
      for (const id of data.dirty) {
        dirty.add(id as DocId);
      }
      // Back-compat: pre-M2 state files have no lastLivePaths/deleted fields.
      for (const [k, v] of Object.entries(data.lastLivePaths ?? {})) {
        lastLive.set(k as DocId, v as VaultPath);
      }
      for (const id of data.deleted ?? []) {
        deletedDocs.add(id as DocId);
      }
      // Back-compat: pre-slice-1 state files have no configBases field.
      for (const [k, v] of Object.entries(data.configBases ?? {})) {
        configBasesMap.set(k as VaultPath, v as Sha256);
      }
      // Back-compat: pre-tiebreak state files have no configLocalVersions field.
      for (const [k, v] of Object.entries(data.configLocalVersions ?? {})) {
        configLocalVersionsMap.set(k as VaultPath, v);
      }
      // Back-compat: pre-slice-2b state files have no localSuppress field.
      for (const id of data.localSuppress ?? []) localSuppressArr.push(id);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      // No file yet → start empty
    }
    return new FsEngineStateStore(
      abs,
      syncedStamps,
      dirty,
      lastLive,
      deletedDocs,
      configBasesMap,
      configLocalVersionsMap,
      localSuppressArr,
    );
  }

  // ---------------------------------------------------------------------------
  // EngineStateStore implementation
  // ---------------------------------------------------------------------------

  getSyncedStamp(id: DocId): Promise<Stamp | null> {
    return Promise.resolve(this.syncedStamps.get(id) ?? null);
  }

  async setSyncedStamp(id: DocId, stamp: Stamp): Promise<void> {
    this.syncedStamps.set(id, stamp);
    await this.persist();
  }

  async markDirty(id: DocId): Promise<void> {
    this.dirty.add(id);
    await this.persist();
  }

  async clearDirty(id: DocId): Promise<void> {
    this.dirty.delete(id);
    await this.persist();
  }

  listDirty(): Promise<DocId[]> {
    return Promise.resolve([...this.dirty]);
  }

  isDirty(id: DocId): Promise<boolean> {
    return Promise.resolve(this.dirty.has(id));
  }

  getLastLivePath(id: DocId): Promise<VaultPath | null> {
    return Promise.resolve(this.lastLive.get(id) ?? null);
  }

  async setLastLivePath(id: DocId, path: VaultPath): Promise<void> {
    if (this.lastLive.get(id) === path) return; // skip-if-unchanged (avoid an O(n^2) backstop rewrite)
    this.lastLive.set(id, path);
    await this.persist();
  }

  async clearLastLivePath(id: DocId): Promise<void> {
    if (!this.lastLive.has(id)) return; // skip-if-unchanged
    this.lastLive.delete(id);
    await this.persist();
  }

  async markDeleted(id: DocId): Promise<void> {
    if (this.deletedDocs.has(id)) return; // skip-if-unchanged
    this.deletedDocs.add(id);
    await this.persist();
  }

  wasDeleted(id: DocId): Promise<boolean> {
    return Promise.resolve(this.deletedDocs.has(id));
  }

  async clearDeleted(id: DocId): Promise<void> {
    if (!this.deletedDocs.has(id)) return; // skip-if-unchanged (hot in noteLiveBinding)
    this.deletedDocs.delete(id);
    await this.persist();
  }

  getConfigBase(path: VaultPath): Promise<Sha256 | null> {
    return Promise.resolve(this.configBasesMap.get(path) ?? null);
  }

  async setConfigBase(path: VaultPath, sha256: Sha256): Promise<void> {
    this.configBasesMap.set(path, sha256);
    await this.persist();
  }

  getConfigLocalVersion(path: VaultPath): Promise<number> {
    return Promise.resolve(this.configLocalVersionsMap.get(path) ?? 0);
  }

  async setConfigLocalVersion(path: VaultPath, version: number): Promise<void> {
    if (this.configLocalVersionsMap.get(path) === version) return; // skip-if-unchanged
    this.configLocalVersionsMap.set(path, version);
    await this.persist();
  }

  getLocalSuppress(): Promise<string[]> {
    return Promise.resolve([...this.localSuppressArr]);
  }

  async setLocalSuppress(ids: string[]): Promise<void> {
    this.localSuppressArr = [...ids];
    await this.persist();
  }

  // ---------------------------------------------------------------------------
  // Test/operator helpers (not part of the EngineStateStore port interface)
  // ---------------------------------------------------------------------------

  /**
   * Drop ALL persisted synced stamps and atomically rewrite the state file so the
   * cleared state SURVIVES a daemon restart. After this, every live doc's stamp is
   * absent from the store, so on the next `engine.start()` every doc is re-pending —
   * the startup self-heal must drain them back to zero over the relay.
   *
   * Calling this while the engine is STOPPED (but the control API is up) is the
   * correct usage: the in-memory map is updated + flushed to disk before the engine
   * reads it again on the next start, so no in-flight setSyncedStamp call races.
   */
  async clearAllSyncedStamps(): Promise<void> {
    this.syncedStamps.clear();
    await this.persist();
  }

  // ---------------------------------------------------------------------------
  // Internal persistence (atomic write)
  // ---------------------------------------------------------------------------

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });

    const data: StateFile = {
      syncedStamps: Object.fromEntries(this.syncedStamps),
      dirty: [...this.dirty],
      lastLivePaths: Object.fromEntries(this.lastLive),
      deleted: [...this.deletedDocs],
      configBases: Object.fromEntries(this.configBasesMap),
      configLocalVersions: Object.fromEntries(this.configLocalVersionsMap),
      localSuppress: [...this.localSuppressArr],
    };
    const json = JSON.stringify(data);
    await atomicWriteBytes(this.filePath, new TextEncoder().encode(json));
  }
}

export async function makeTmpEngineState(): Promise<{
  store: FsEngineStateStore;
  filePath: string;
}> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-state-"));
  const filePath = path.join(dir, "state.json");
  return { store: await FsEngineStateStore.open(filePath), filePath };
}
