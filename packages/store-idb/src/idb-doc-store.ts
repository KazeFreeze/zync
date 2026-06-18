/**
 * IdbDocStore — DocStorePort over the `docs` object store of the shared Zync db.
 *
 * Each DocId is a string key mapping to its opaque CRDT snapshot (Uint8Array).
 * IndexedDB structured-clones the Uint8Array, so binary bytes round-trip
 * exactly. `load` returns null when absent; `delete` is a no-op when absent;
 * `list` enumerates the `docs` keys (no cross-db `indexedDB.databases()` call).
 *
 * Durability comes from IndexedDB itself — a committed `put`/`delete` survives
 * reopen, which is the crash-survival property the engine relies on.
 */
import type { DocId, DocStorePort } from "@zync/core";
import { DOCS_STORE, type ZyncDb } from "./idb-open.js";

export class IdbDocStore implements DocStorePort {
  private readonly db: ZyncDb;

  constructor(db: ZyncDb) {
    this.db = db;
  }

  async load(id: DocId): Promise<Uint8Array | null> {
    const value = await this.db.get(DOCS_STORE, id);
    return value ?? null;
  }

  async save(id: DocId, snapshot: Uint8Array): Promise<void> {
    await this.db.put(DOCS_STORE, snapshot, id);
  }

  async delete(id: DocId): Promise<void> {
    // IndexedDB delete is already a no-op for absent keys — matches the port.
    await this.db.delete(DOCS_STORE, id);
  }

  async list(): Promise<DocId[]> {
    const keys = await this.db.getAllKeys(DOCS_STORE);
    return keys.map((k) => k as DocId);
  }
}
