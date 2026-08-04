/**
 * FsEngineStateStore — crash-survivable EngineStateStore backed by a JSON file.
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
 *
 * ONE facet lives outside that file: the index snapshot, in an `index-snapshot.json` SIDECAR
 * next to it. See {@link FsEngineStateStore.setIndexSnapshot} for why.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type {
  DocId,
  EngineStateStore,
  IndexSnapshotRecord,
  Sha256,
  Stamp,
  VaultPath,
} from "@zync/core";
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
  // H3 normalized sha: hook-owned plugin-data rewrite accepted as equivalent to the agreed base.
  // Optional for back-compat (pre-H3 state files have no key).
  configNormalizedShas?: Record<string, string>;
  // plugin-data version-aware convergence: numeric edit-version of the on-disk value per config path.
  // Optional for back-compat (pre-tiebreak state files have no key → every path reads as version 0).
  configLocalVersions?: Record<string, number>;
  // Slice 2b: per-device suppress list. Optional for back-compat (pre-2b state files have no key).
  localSuppress?: string[];
}

/**
 * On-disk shape of the index-snapshot sidecar. `IndexSnapshotRecord.snapshot` is a `Uint8Array`
 * and this store is JSON, so the bytes are base64'd on write and decoded on read. Keep the two
 * halves symmetric: a silent asymmetry hands the engine a CORRUPT snapshot that still "loads".
 */
interface SerializedIndexSnapshot {
  version: number;
  identity: string;
  substrate: string;
  snapshotB64: string;
}

export class FsEngineStateStore implements EngineStateStore {
  private readonly filePath: string;
  private readonly indexSnapshotPath: string;
  private syncedStamps: Map<DocId, Stamp>;
  private dirty: Set<DocId>;
  private lastLive: Map<DocId, VaultPath>;
  private deletedDocs: Set<DocId>;
  private configBasesMap: Map<VaultPath, Sha256>;
  private configNormalizedShasMap: Map<VaultPath, Sha256>;
  private configLocalVersionsMap: Map<VaultPath, number>;
  private localSuppressArr: string[];

  private constructor(
    filePath: string,
    syncedStamps: Map<DocId, Stamp>,
    dirty: Set<DocId>,
    lastLive: Map<DocId, VaultPath>,
    deletedDocs: Set<DocId>,
    configBasesMap: Map<VaultPath, Sha256>,
    configNormalizedShasMap: Map<VaultPath, Sha256>,
    configLocalVersionsMap: Map<VaultPath, number>,
    localSuppressArr: string[],
  ) {
    this.filePath = filePath;
    this.indexSnapshotPath = path.join(path.dirname(filePath), "index-snapshot.json");
    this.syncedStamps = syncedStamps;
    this.dirty = dirty;
    this.lastLive = lastLive;
    this.deletedDocs = deletedDocs;
    this.configBasesMap = configBasesMap;
    this.configNormalizedShasMap = configNormalizedShasMap;
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
    const configNormalizedShasMap = new Map<VaultPath, Sha256>();
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
      // Back-compat: pre-H3 state files have no configNormalizedShas field.
      for (const [k, v] of Object.entries(data.configNormalizedShas ?? {})) {
        configNormalizedShasMap.set(k as VaultPath, v as Sha256);
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
      configNormalizedShasMap,
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
    this.configNormalizedShasMap.delete(path);
    await this.persist();
  }

  getConfigNormalizedSha(path: VaultPath): Promise<Sha256 | null> {
    return Promise.resolve(this.configNormalizedShasMap.get(path) ?? null);
  }

  async setConfigNormalizedSha(path: VaultPath, sha256: Sha256 | null): Promise<void> {
    if (sha256 === null) this.configNormalizedShasMap.delete(path);
    else this.configNormalizedShasMap.set(path, sha256);
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

  /**
   * The persisted shared-index snapshot, or null when there is none (or it is unreadable).
   * Read exactly ONCE per `engine.start()`, so it is loaded straight off disk rather than held
   * resident for the daemon's whole life.
   */
  async getIndexSnapshot(): Promise<IndexSnapshotRecord | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexSnapshotPath, "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    const rec = JSON.parse(raw) as SerializedIndexSnapshot;
    return {
      version: rec.version,
      identity: rec.identity,
      substrate: rec.substrate,
      snapshot: new Uint8Array(Buffer.from(rec.snapshotB64, "base64")),
    };
  }

  /**
   * ONE atomic rewrite of a SIDECAR file — deliberately NOT a facet of the main state file.
   *
   * `persist()` rewrites the entire state JSON on every synced-stamp / dirty-flag write, which
   * happens once per doc: ~1,660 times over the lifeos fixture alone. A base64'd snapshot is
   * ~950 KB on a vault that size, so embedding it here would re-serialize and re-fsync roughly a
   * gigabyte of unchanged bytes per scenario. The sidecar keeps those hot writes small, and the
   * snapshot's own write is coalesced upstream by the engine's single-flight `persistIndexNow`.
   *
   * Atomic (temp + rename + parent-dir fsync), so a SIGKILL mid-write leaves the PREVIOUS snapshot
   * rather than a torn one. Never split this across two files: the metadata and the bytes must
   * commit together or an identity/version check would pass against the wrong payload.
   *
   * The sidecar name is fixed, so it assumes ONE state store per directory — true by construction
   * (each device owns its `.obsidian/zync`, each test its own temp dir). If that ever stops
   * holding, derive the name from the state file's basename rather than sharing a directory.
   */
  async setIndexSnapshot(rec: IndexSnapshotRecord): Promise<void> {
    await fsp.mkdir(path.dirname(this.indexSnapshotPath), { recursive: true });
    const payload: SerializedIndexSnapshot = {
      version: rec.version,
      identity: rec.identity,
      substrate: rec.substrate,
      snapshotB64: Buffer.from(rec.snapshot).toString("base64"),
    };
    await atomicWriteBytes(
      this.indexSnapshotPath,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
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
      configNormalizedShas: Object.fromEntries(this.configNormalizedShasMap),
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
