import type { DocId, EngineStateStore, Sha256, Stamp, VaultPath } from "../ports.js";

/**
 * In-memory {@link EngineStateStore} for tests: a `Map` of per-doc synced stamps
 * plus a `Set` of dirty docs. Methods return resolved promises (no real I/O);
 * they are intentionally NOT marked `async` so `require-await` stays satisfied,
 * matching the `FakeVault` style.
 */
export class MemEngineState implements EngineStateStore {
  private readonly synced = new Map<DocId, Stamp>();
  private readonly dirty = new Set<DocId>();
  private readonly lastLive = new Map<DocId, VaultPath>();
  private readonly deleted = new Set<DocId>();
  private readonly configBases = new Map<VaultPath, Sha256>();
  private readonly configLocalVersions = new Map<VaultPath, number>();
  private localSuppressArr: string[] = [];

  getSyncedStamp(id: DocId): Promise<Stamp | null> {
    return Promise.resolve(this.synced.get(id) ?? null);
  }

  setSyncedStamp(id: DocId, stamp: Stamp): Promise<void> {
    this.synced.set(id, stamp);
    return Promise.resolve();
  }

  /**
   * TEST-ONLY: drop ALL persisted synced stamps to simulate synced-stamp store loss
   * (a relay reset / server migration where the per-doc synced stamps were not preserved).
   * After this, every live doc's `entry.stamp !== getSyncedStamp(docId)`, so
   * {@link SyncEngine.pendingDocs} reports every doc as pending — the exact condition the
   * engine's background self-heal must drain back to empty without any external change.
   *
   * NOTE (control-API seam): a real EngineStateStore has no such method — this is the
   * in-memory test double's simulation of durable-store loss. If a production
   * "drop synced stamps" control hook is ever wanted (e.g. an operator forcing a re-sync
   * after a relay migration), it would live on the engine as a method that clears the
   * synced stamps behind the port and then calls the internal reconcile scheduler to arm
   * the background self-heal (which drains pending back to zero on its own).
   */
  clearAllSyncedStamps(): void {
    this.synced.clear();
  }

  markDirty(id: DocId): Promise<void> {
    this.dirty.add(id);
    return Promise.resolve();
  }

  clearDirty(id: DocId): Promise<void> {
    this.dirty.delete(id);
    return Promise.resolve();
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

  setLastLivePath(id: DocId, path: VaultPath): Promise<void> {
    if (this.lastLive.get(id) === path) return Promise.resolve(); // skip-if-unchanged
    this.lastLive.set(id, path);
    return Promise.resolve();
  }

  clearLastLivePath(id: DocId): Promise<void> {
    if (!this.lastLive.has(id)) return Promise.resolve(); // skip-if-unchanged
    this.lastLive.delete(id);
    return Promise.resolve();
  }

  markDeleted(id: DocId): Promise<void> {
    if (this.deleted.has(id)) return Promise.resolve(); // skip-if-unchanged
    this.deleted.add(id);
    return Promise.resolve();
  }

  wasDeleted(id: DocId): Promise<boolean> {
    return Promise.resolve(this.deleted.has(id));
  }

  clearDeleted(id: DocId): Promise<void> {
    if (!this.deleted.has(id)) return Promise.resolve(); // skip-if-unchanged
    this.deleted.delete(id);
    return Promise.resolve();
  }

  getConfigBase(path: VaultPath): Promise<Sha256 | null> {
    return Promise.resolve(this.configBases.get(path) ?? null);
  }

  setConfigBase(path: VaultPath, sha256: Sha256): Promise<void> {
    this.configBases.set(path, sha256);
    return Promise.resolve();
  }

  getConfigLocalVersion(path: VaultPath): Promise<number> {
    return Promise.resolve(this.configLocalVersions.get(path) ?? 0);
  }

  setConfigLocalVersion(path: VaultPath, version: number): Promise<void> {
    this.configLocalVersions.set(path, version);
    return Promise.resolve();
  }

  getLocalSuppress(): Promise<string[]> {
    return Promise.resolve([...this.localSuppressArr]);
  }
  setLocalSuppress(ids: string[]): Promise<void> {
    this.localSuppressArr = [...ids];
    return Promise.resolve();
  }
}
