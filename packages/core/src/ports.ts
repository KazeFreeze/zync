export type DocId = string & { readonly __brand: "DocId" };
export type VaultPath = string & { readonly __brand: "VaultPath" };
export type Sha256 = string & { readonly __brand: "Sha256" };
export type DeviceId = string & { readonly __brand: "DeviceId" };
export type Unsubscribe = () => void;

/**
 * The id of the ALWAYS-attached index doc (0b-2 §B). Every device attaches this
 * one doc on start; note docs attach lazily. Its `tree`/`inbox`/`blobs` maps carry
 * the shared sync metadata. Fixed string so every device addresses the same doc.
 */
export const INDEX_DOC_ID = "__zync_index__" as DocId;

export interface TextEdit {
  at: number;
  delete: number;
  insert: string;
}
export type EditOrigin = "local-bridge" | "local-editor" | "remote";

export interface CrdtProvider {
  createDoc(id: DocId): CrdtDoc;
  loadDoc(id: DocId, snapshot: Uint8Array): CrdtDoc;
}
export interface CrdtDoc {
  readonly id: DocId;
  getText(): string;
  applyEdits(edits: TextEdit[], origin: EditOrigin): void;
  encodeStateVector(): Uint8Array;
  encodeSnapshot(): Uint8Array;
  encodeUpdateSince(stateVector: Uint8Array): Uint8Array;
  applyUpdate(update: Uint8Array, origin: EditOrigin): void;
  onUpdate(cb: (update: Uint8Array, origin: EditOrigin) => void): Unsubscribe;
  /** A named map within this doc — used by the index doc's `tree`/`blobs` (0b-2 §B). */
  getMap<V>(name: string): CrdtMap<V>;
  destroy(): void;
}

/** Y.Map semantics: a per-key LWW register. Concurrent `set`s on the same key converge by LWW. */
export interface CrdtMap<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
  entries(): [string, V][];
  observe(cb: (changedKeys: string[]) => void): Unsubscribe;
}

export type VaultEvent =
  | { type: "create" | "modify" | "delete"; path: VaultPath }
  | { type: "rename"; path: VaultPath; oldPath: VaultPath };

export interface VaultPort {
  read(path: VaultPath): Promise<Uint8Array | null>;
  writeAtomic(path: VaultPath, data: Uint8Array, opts?: { mtime?: number }): Promise<void>;
  remove(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  list(prefix?: VaultPath): Promise<{ path: VaultPath; size: number; mtime: number }[]>;
  onEvent(cb: (e: VaultEvent) => void): Unsubscribe;
}

export type ConnStatus = "connected" | "connecting" | "offline" | "unauthorized";

/**
 * Offline/reconnect contract (0b-2 §A) — adapters MUST honor it:
 * - `status()` never throws.
 * - `attach(doc)` while offline returns an `AttachedDoc` immediately; never throws; queues until connected.
 * - `AttachedDoc.synced()` resolves after the FIRST successful state-vector exchange; during a partition it
 *   stays PENDING (never rejects, never resolves stale).
 * - On reconnect, an attached doc AUTO-resyncs (re-exchanges state vectors); the engine does NOT re-attach.
 * - `close()` detaches all; in-flight `synced()` promises reject with a typed `ClosedError`.
 */
export interface TransportPort {
  status(): ConnStatus;
  onStatus(cb: (s: ConnStatus) => void): Unsubscribe;
  attach(doc: CrdtDoc): AttachedDoc;
  close(): Promise<void>;
}
export interface AttachedDoc {
  synced(): Promise<void>;
  detach(): void;
}

export interface BlobStorePort {
  has(sha: Sha256): Promise<boolean>;
  put(sha: Sha256, data: Uint8Array): Promise<void>;
  get(sha: Sha256): Promise<Uint8Array>;
}
export interface DocStorePort {
  load(id: DocId): Promise<Uint8Array | null>;
  save(id: DocId, snapshot: Uint8Array): Promise<void>;
  delete(id: DocId): Promise<void>;
  list(): Promise<DocId[]>;
}

/** A content stamp: `${sha256(text)}:${deviceId}` — content hash + author. Compare HASH PART only (0b-2 §B). */
export type Stamp = string;

/**
 * Engine sync-metadata that must survive crash/restart (0b-2 §A). Distinct from `DocStorePort`
 * (which holds CRDT snapshots): this records, per doc, the last stamp this device reconciled and
 * whether it carries local edits not yet durably pushed — the thing that, after an offline
 * crash+restart, tells the engine which docs still owe an upstream push.
 */
export interface EngineStateStore {
  getSyncedStamp(id: DocId): Promise<Stamp | null>;
  setSyncedStamp(id: DocId, stamp: Stamp): Promise<void>;
  markDirty(id: DocId): Promise<void>;
  clearDirty(id: DocId): Promise<void>;
  listDirty(): Promise<DocId[]>;
}
export interface ClockPort {
  now(): number;
}
export interface IdentityPort {
  deviceId(): DeviceId;
  deviceName(): string;
}
