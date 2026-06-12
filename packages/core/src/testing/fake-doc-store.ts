import type { DocId, DocStorePort } from "../ports.js";

/**
 * In-memory {@link DocStorePort} for tests: a `Map<DocId, Uint8Array>` of CRDT
 * snapshots. `load` returns the stored snapshot or `null` (never `undefined`).
 * Methods return resolved promises (no real I/O) and are intentionally NOT marked
 * `async` so `require-await` stays satisfied, matching the `FakeVault` style.
 */
export class FakeDocStore implements DocStorePort {
  private readonly snapshots = new Map<DocId, Uint8Array>();

  load(id: DocId): Promise<Uint8Array | null> {
    return Promise.resolve(this.snapshots.get(id) ?? null);
  }

  save(id: DocId, snapshot: Uint8Array): Promise<void> {
    this.snapshots.set(id, snapshot);
    return Promise.resolve();
  }

  delete(id: DocId): Promise<void> {
    this.snapshots.delete(id);
    return Promise.resolve();
  }

  list(): Promise<DocId[]> {
    return Promise.resolve([...this.snapshots.keys()]);
  }
}
