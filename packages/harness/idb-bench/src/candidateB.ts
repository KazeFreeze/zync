/**
 * Candidate B — custom single-DB KV over Jake Archibald's `idb`.
 *
 * ONE IndexedDB database (`zync-bench-kv`) with three object stores:
 *   - `docs`         key=docId → opaque Yjs snapshot (Uint8Array)   [DocStorePort]
 *   - `engine_state` key=docId → { syncedStamp, dirty }             [EngineStateStore]
 *   - `meta`         key=string → arbitrary (schema version etc.)
 *
 * This is the shape a real Zync `DocStorePort`+`EngineStateStore` adapter would take:
 * save = put, load = get, list = getAllKeys, delete = delete. No per-doc DB, no
 * update-log/compaction — the engine already hands us a compacted opaque snapshot.
 *
 * PORTABLE: depends only on `idb` and browser globals.
 */
import { openDB, type IDBPDatabase } from "idb";
import type { EngineState, PersistenceCandidate } from "./candidate";

const DB_NAME = "zync-bench-kv";
const DB_VERSION = 1;

interface BenchSchema {
  docs: { key: string; value: Uint8Array };
  engine_state: { key: string; value: EngineState };
  meta: { key: string; value: unknown };
}

export class CandidateB implements PersistenceCandidate {
  readonly name = "B: single-DB KV (idb)";
  private db: IDBPDatabase<BenchSchema> | null = null;

  async open(): Promise<void> {
    this.db = await openDB<BenchSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs");
        if (!db.objectStoreNames.contains("engine_state")) {
          db.createObjectStore("engine_state");
        }
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      },
    });
    await this.db.put("meta", DB_VERSION, "schemaVersion");
  }

  private require(): IDBPDatabase<BenchSchema> {
    if (!this.db) throw new Error("CandidateB not open");
    return this.db;
  }

  async save(id: string, snapshot: Uint8Array, state: EngineState): Promise<void> {
    const db = this.require();
    // One tx across both stores keeps the snapshot + its stamp atomically consistent.
    const tx = db.transaction(["docs", "engine_state"], "readwrite");
    await Promise.all([
      tx.objectStore("docs").put(snapshot, id),
      tx.objectStore("engine_state").put(state, id),
      tx.done,
    ]);
  }

  async load(id: string): Promise<Uint8Array | null> {
    const v = await this.require().get("docs", id);
    return v ?? null;
  }

  async loadState(id: string): Promise<EngineState | null> {
    const v = await this.require().get("engine_state", id);
    return v ?? null;
  }

  async list(): Promise<string[]> {
    const keys = await this.require().getAllKeys("docs");
    return keys.map(String).sort();
  }

  async delete(id: string): Promise<void> {
    const db = this.require();
    const tx = db.transaction(["docs", "engine_state"], "readwrite");
    await Promise.all([
      tx.objectStore("docs").delete(id),
      tx.objectStore("engine_state").delete(id),
      tx.done,
    ]);
  }

  close(): Promise<void> {
    this.db?.close();
    this.db = null;
    return Promise.resolve();
  }
}
