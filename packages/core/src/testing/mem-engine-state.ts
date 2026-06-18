import type { DocId, EngineStateStore, Stamp } from "../ports.js";

/**
 * In-memory {@link EngineStateStore} for tests: a `Map` of per-doc synced stamps
 * plus a `Set` of dirty docs. Methods return resolved promises (no real I/O);
 * they are intentionally NOT marked `async` so `require-await` stays satisfied,
 * matching the `FakeVault` style.
 */
export class MemEngineState implements EngineStateStore {
  private readonly synced = new Map<DocId, Stamp>();
  private readonly dirty = new Set<DocId>();

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
}
