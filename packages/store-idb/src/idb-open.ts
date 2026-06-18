/**
 * openZyncDb — opens (and on first run creates) the ONE IndexedDB database that
 * backs both Zync persistence adapters.
 *
 * Schema (db version 1) — three object stores, each a simple key→value KV:
 *   - `docs`         key=docId (string) → opaque CRDT snapshot (Uint8Array)  [DocStorePort]
 *   - `engine_state` key=docId (string) → { syncedStamp, dirty }            [EngineStateStore]
 *   - `meta`         key=string → arbitrary (schema version, future use)
 *
 * Both {@link IdbDocStore} and {@link IdbEngineState} are constructed from the
 * SAME handle returned here, so the plugin opens exactly one database. The two
 * adapters never collide: they address different object stores.
 *
 * Browser-targeted: uses the global `indexedDB` (which `idb` wraps). No `node:*`.
 * `list()` enumerates `docs` keys directly (NOT `indexedDB.databases()`, which
 * Firefox lacks) — the single-DB design needs no cross-db enumeration at all.
 */
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Stamp } from "@zync/core";

/** Per-doc engine sync-metadata persisted in the `engine_state` store. */
export interface EngineStateRecord {
  syncedStamp: Stamp | null;
  dirty: boolean;
}

export interface ZyncSchema extends DBSchema {
  docs: { key: string; value: Uint8Array };
  engine_state: { key: string; value: EngineStateRecord };
  meta: { key: string; value: unknown };
}

export type ZyncDb = IDBPDatabase<ZyncSchema>;

export const ZYNC_DB_VERSION = 1;
export const DEFAULT_ZYNC_DB_NAME = "zync";

export const DOCS_STORE = "docs";
export const ENGINE_STATE_STORE = "engine_state";
export const META_STORE = "meta";

/**
 * Registry of open handles by db name. The production plugin keeps its own
 * handle and calls `db.close()`; this registry lets the test-only
 * {@link closeZyncDb} close a db by name to simulate a process restart, and
 * lets {@link deleteZyncDb} ensure the handle is closed before deletion (a
 * still-open connection blocks `deleteDatabase`).
 */
const handles = new Map<string, ZyncDb>();

export async function openZyncDb(name: string = DEFAULT_ZYNC_DB_NAME): Promise<ZyncDb> {
  const db = await openDB<ZyncSchema>(name, ZYNC_DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(DOCS_STORE)) {
        database.createObjectStore(DOCS_STORE);
      }
      if (!database.objectStoreNames.contains(ENGINE_STATE_STORE)) {
        database.createObjectStore(ENGINE_STATE_STORE);
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
    },
  });
  await db.put(META_STORE, ZYNC_DB_VERSION, "schemaVersion");
  handles.set(name, db);
  return db;
}

/** Close the open handle for `name` (no-op if none). Simulates a restart in tests. */
export function closeZyncDb(name: string): void {
  const db = handles.get(name);
  if (db) {
    db.close();
    handles.delete(name);
  }
}

/** Close (if open) then delete the database `name`. Used for test teardown. */
export async function deleteZyncDb(name: string): Promise<void> {
  closeZyncDb(name);
  await deleteDB(name);
}
