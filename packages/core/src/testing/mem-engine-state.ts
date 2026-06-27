import type { DocId, EngineStateStore, Stamp, VaultPath } from "../ports.js";

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

  getSyncedStamp(id: DocId): Promise<Stamp | null> {
    return Promise.resolve(this.synced.get(id) ?? null);
  }

  setSyncedStamp(id: DocId, stamp: Stamp): Promise<void> {
    this.synced.set(id, stamp);
    return Promise.resolve();
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
}
