/**
 * Candidate A — stock `y-indexeddb` (^9.0.12), ONE IndexedDB database per note.
 *
 * This is y-indexeddb's native model: `new IndexeddbPersistence(docId, ydoc)` opens
 * a DB literally named `docId`, mirrors the Y.Doc into an incremental update-log
 * object store, and compacts at PREFERRED_TRIM_SIZE. With ~1,260 notes that is
 * ~1,260 separate IDB databases.
 *
 * Mapping to the candidate contract:
 *   - save(id, snapshot): get/create the per-doc `IndexeddbPersistence`, apply the
 *     snapshot as a Yjs update to its Y.Doc (the provider persists it), `whenSynced`.
 *     The first save for a doc therefore also captures `whenSynced` latency.
 *   - load(id): `new IndexeddbPersistence(id, fresh Y.Doc)` + `whenSynced`, then
 *     `Y.encodeStateAsUpdate` — the opaque snapshot back out.
 *   - list(): enumerate IDB databases via `indexedDB.databases()`, filtering to the
 *     doc-name + engine-state-name prefixes.
 *   - engine-state: a SECOND tiny per-doc DB (`<id>::state`) holding one record, to
 *     mirror EngineStateStore without polluting the y-indexeddb log.
 *
 * PORTABLE: depends only on `yjs`, `y-indexeddb`, and browser globals.
 */
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import type { EngineState, PersistenceCandidate } from "./candidate";

const STATE_SUFFIX = "::state";

/** Open (or create) a plain one-store IDB DB for a doc's engine-state record. */
function openStateDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error(`open ${name} failed`));
    };
  });
}

function putState(db: IDBDatabase, state: EngineState): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(state, "state");
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("putState failed"));
    };
  });
}

function getState(db: IDBDatabase): Promise<EngineState | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get("state");
    req.onsuccess = () => {
      resolve((req.result as EngineState | undefined) ?? null);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("getState failed"));
    };
  });
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => {
      resolve();
    };
    req.onerror = () => {
      reject(req.error ?? new Error(`delete ${name} failed`));
    };
    // Some engines fire `blocked` if a connection is still open; resolve anyway
    // after the open handles are dropped by the caller.
    req.onblocked = () => {
      resolve();
    };
  });
}

interface DocHandle {
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
  stateDb: IDBDatabase;
}

export class CandidateA implements PersistenceCandidate {
  readonly name = "A: stock y-indexeddb (one DB per doc)";
  private readonly handles = new Map<string, DocHandle>();
  /** whenSynced latencies (ms) captured on first open of each doc. */
  readonly whenSyncedSamples: number[] = [];

  open(): Promise<void> {
    // No global handle — each doc opens its own DB on demand.
    return Promise.resolve();
  }

  private async ensure(id: string): Promise<DocHandle> {
    let h = this.handles.get(id);
    if (h) return h;
    const ydoc = new Y.Doc();
    const t0 = performance.now();
    const persistence = new IndexeddbPersistence(id, ydoc);
    await persistence.whenSynced;
    this.whenSyncedSamples.push(performance.now() - t0);
    const stateDb = await openStateDb(id + STATE_SUFFIX);
    h = { ydoc, persistence, stateDb };
    this.handles.set(id, h);
    return h;
  }

  async save(id: string, snapshot: Uint8Array, state: EngineState): Promise<void> {
    const h = await this.ensure(id);
    // Apply the opaque snapshot as a Yjs update; y-indexeddb persists it to the log.
    Y.applyUpdate(h.ydoc, snapshot, "bench-save");
    // Force the provider to flush the pending update into IDB before returning.
    await h.persistence.whenSynced;
    await putState(h.stateDb, state);
  }

  async load(id: string): Promise<Uint8Array | null> {
    const h = await this.ensure(id);
    const update = Y.encodeStateAsUpdate(h.ydoc);
    // An empty doc encodes to a 2-byte "no content" update; treat that as absent.
    return update.byteLength <= 2 ? null : update;
  }

  async loadState(id: string): Promise<EngineState | null> {
    const h = await this.ensure(id);
    return getState(h.stateDb);
  }

  async list(): Promise<string[]> {
    // `indexedDB.databases()` is the structural enumerator. We classify by suffix:
    // the doc DBs are the names WITHOUT the state suffix.
    const dbs = await indexedDB.databases();
    const ids: string[] = [];
    for (const info of dbs) {
      const n = info.name;
      if (!n) continue;
      if (n.endsWith(STATE_SUFFIX)) continue;
      ids.push(n);
    }
    return ids.sort();
  }

  async delete(id: string): Promise<void> {
    const h = this.handles.get(id);
    if (h) {
      await h.persistence.destroy(); // closes the y-indexeddb connection
      h.ydoc.destroy();
      h.stateDb.close();
      this.handles.delete(id);
    }
    await deleteDb(id);
    await deleteDb(id + STATE_SUFFIX);
  }

  async close(): Promise<void> {
    for (const h of this.handles.values()) {
      await h.persistence.destroy();
      h.ydoc.destroy();
      h.stateDb.close();
    }
    this.handles.clear();
  }
}
