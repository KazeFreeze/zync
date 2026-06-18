/**
 * @zync/store-idb — production single-DB IndexedDB persistence for the engine's
 * `DocStorePort` + `EngineStateStore`.
 *
 * Open ONE database with {@link openZyncDb} and construct both adapters from the
 * same handle:
 *
 *   const db = await openZyncDb("zync");
 *   const docStore = new IdbDocStore(db);
 *   const engineState = new IdbEngineState(db);
 */
export { IdbDocStore } from "./idb-doc-store.js";
export { IdbEngineState } from "./idb-engine-state.js";
export {
  openZyncDb,
  closeZyncDb,
  deleteZyncDb,
  DEFAULT_ZYNC_DB_NAME,
  ZYNC_DB_VERSION,
  DOCS_STORE,
  ENGINE_STATE_STORE,
  META_STORE,
  type ZyncDb,
  type ZyncSchema,
  type EngineStateRecord,
} from "./idb-open.js";
