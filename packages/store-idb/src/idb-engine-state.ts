/**
 * IdbEngineState — EngineStateStore over the `engine_state` object store of the
 * shared Zync db.
 *
 * One record per docId: `{ syncedStamp: Stamp | null, dirty: boolean }`. The
 * synced-stamp and the dirty flag are INDEPENDENT facets of the same record, so
 * each mutation reads the existing record inside a single readwrite transaction
 * and writes it back with only the relevant facet changed — `markDirty` never
 * clobbers a synced stamp, `setSyncedStamp` never clears the dirty flag.
 *
 * `listDirty` returns the set of docIds whose record has `dirty === true`
 * (a set: a docId appears at most once). All of this is durable across reopen
 * because it lives in IndexedDB — the engine's crash-restart guarantee.
 */
import type { DocId, EngineStateStore, Stamp } from "@zync/core";
import { ENGINE_STATE_STORE, type EngineStateRecord, type ZyncDb } from "./idb-open.js";

function emptyRecord(): EngineStateRecord {
  return { syncedStamp: null, dirty: false };
}

export class IdbEngineState implements EngineStateStore {
  private readonly db: ZyncDb;

  constructor(db: ZyncDb) {
    this.db = db;
  }

  async getSyncedStamp(id: DocId): Promise<Stamp | null> {
    const rec = await this.db.get(ENGINE_STATE_STORE, id);
    return rec?.syncedStamp ?? null;
  }

  async setSyncedStamp(id: DocId, stamp: Stamp): Promise<void> {
    await this.mutate(id, (rec) => ({ ...rec, syncedStamp: stamp }));
  }

  async markDirty(id: DocId): Promise<void> {
    await this.mutate(id, (rec) => ({ ...rec, dirty: true }));
  }

  async clearDirty(id: DocId): Promise<void> {
    await this.mutate(id, (rec) => ({ ...rec, dirty: false }));
  }

  async listDirty(): Promise<DocId[]> {
    const tx = this.db.transaction(ENGINE_STATE_STORE, "readonly");
    const store = tx.objectStore(ENGINE_STATE_STORE);
    const dirty: DocId[] = [];
    let cursor = await store.openCursor();
    while (cursor) {
      if (cursor.value.dirty) dirty.push(cursor.key as DocId);
      cursor = await cursor.continue();
    }
    await tx.done;
    return dirty;
  }

  /** O(1) single-key lookup — avoids the full {@link listDirty} cursor scan for a membership check. */
  async isDirty(id: DocId): Promise<boolean> {
    const rec = await this.db.get(ENGINE_STATE_STORE, id);
    return rec?.dirty ?? false;
  }

  /**
   * Read-modify-write a single record inside ONE readwrite transaction so the
   * two facets (synced stamp, dirty flag) never race with each other. Absent
   * records start from an empty record.
   */
  private async mutate(
    id: DocId,
    update: (rec: EngineStateRecord) => EngineStateRecord,
  ): Promise<void> {
    const tx = this.db.transaction(ENGINE_STATE_STORE, "readwrite");
    const store = tx.objectStore(ENGINE_STATE_STORE);
    const existing = (await store.get(id)) ?? emptyRecord();
    await store.put(update(existing), id);
    await tx.done;
  }
}
