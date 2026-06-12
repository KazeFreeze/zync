import type { Route } from "../classify/classify.js";
import type { CrdtMap, DeviceId, DocId, Sha256, Unsubscribe, VaultPath } from "../ports.js";
import { makeStamp } from "./stamp.js";

/**
 * One row of the index `tree` (0b-2 §B): the {@link DocId} backing a vault path,
 * its sync {@link Route}, and the current content {@link makeStamp stamp}.
 * `deleted` marks a tombstone — see {@link IndexDoc.delete}.
 */
export interface TreeEntry {
  docId: DocId;
  type: Route;
  stamp: string;
  deleted?: boolean;
}

/**
 * The shared index document: a `CrdtMap<TreeEntry>` keyed by {@link VaultPath}
 * (the underlying map uses `string` keys; we cast to/from `VaultPath`). Each
 * `set` is a per-key LWW register, so concurrent edits to the same path converge
 * deterministically (proven against the real `YjsCrdtMap` in the convergence
 * test, not the single-replica `FakeCrdtMap`).
 *
 * TOMBSTONES: {@link delete} writes `{ ...existing, deleted: true }` rather than
 * dropping the key, KEEPING `docId`/`type` so a concurrent edit can win an
 * edit-beats-delete race. NOTE: full edit-beats-delete RESURRECTION is Task 8 —
 * this only lays the tombstone marker.
 */
export class IndexDoc {
  constructor(
    private readonly tree: CrdtMap<TreeEntry>,
    private readonly deviceId: DeviceId,
  ) {}

  get(path: VaultPath): TreeEntry | undefined {
    return this.tree.get(path);
  }

  /** Stamp a path with the current content hash (authored by this device). */
  setStamp(path: VaultPath, docId: DocId, type: Route, sha: Sha256): void {
    this.tree.set(path, { docId, type, stamp: makeStamp(sha, this.deviceId) });
  }

  /**
   * Write a fully-formed {@link TreeEntry} at `path` as a single LWW register
   * write. Used by the tombstone bridge to lay a tombstone whose `stamp` encodes
   * the content hash at delete time (see `bridge/tombstone.ts`); the bridge owns
   * the entry's shape (it carries an explicit authoring device), so this is a
   * thin pass-through rather than re-stamping with this device.
   */
  setTombstone(path: VaultPath, entry: TreeEntry): void {
    this.tree.set(path, { ...entry, deleted: true });
  }

  /**
   * Move an entry from `from` to `to`, carrying the SAME `docId` (the document's
   * identity survives the rename), then tombstone the old key. If there is no
   * entry at `from`, this is a no-op.
   */
  rename(from: VaultPath, to: VaultPath): void {
    const existing = this.tree.get(from);
    if (existing === undefined) return;
    this.tree.set(to, { ...existing, deleted: false });
    this.tree.set(from, { ...existing, deleted: true });
  }

  /**
   * Tombstone a path. Writes `{ ...existing, deleted: true }` keeping
   * `docId`/`type` so Task 8 can compare against a concurrent edit. If no entry
   * exists, a minimal tombstone (placeholder `docId`/`type`) is laid so the
   * deletion still propagates as an LWW write.
   */
  delete(path: VaultPath): void {
    const existing = this.tree.get(path);
    if (existing === undefined) {
      this.tree.set(path, {
        docId: "" as DocId,
        type: "excluded",
        stamp: "",
        deleted: true,
      });
      return;
    }
    this.tree.set(path, { ...existing, deleted: true });
  }

  /** Every non-tombstoned `[path, entry]`. */
  liveEntries(): [VaultPath, TreeEntry][] {
    return this.entries().filter(([, e]) => e.deleted !== true);
  }

  /** Every `[path, entry]`, INCLUDING tombstones. */
  entries(): [VaultPath, TreeEntry][] {
    return this.tree.entries().map(([k, v]) => [k as VaultPath, v]);
  }

  observe(cb: (changedPaths: VaultPath[]) => void): Unsubscribe {
    return this.tree.observe((keys) => {
      cb(keys as VaultPath[]);
    });
  }
}
