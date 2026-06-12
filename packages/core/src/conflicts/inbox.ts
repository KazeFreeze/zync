import type { CrdtMap, DocId, Unsubscribe, VaultPath } from "../ports.js";

export type InboxKind = "conflict" | "resurrected" | "supervised-import";

/**
 * One inbox entry. The `id` is DETERMINISTIC (e.g. `${kind}:${path}:${discriminator}`)
 * so the SAME underlying event yields the same key on every device — a duplicate
 * `add` is an LWW re-`set` of one key, never a second entry.
 *
 * `deleted` is the tombstone marker: resolving an entry re-`set`s it with
 * `deleted: true` (not a key-drop), so after sync it is gone from EVERY replica's
 * {@link Inbox.list} without a concurrent re-add resurrecting it.
 */
export interface InboxEntry {
  id: string;
  kind: InboxKind;
  path: VaultPath;
  docId?: DocId;
  artifactPath?: VaultPath;
  detail?: string;
  deleted?: boolean;
}

/**
 * A synced inbox over a `CrdtMap<InboxEntry>` (per-entry LWW register, keyed by
 * {@link InboxEntry.id}). Resolving = tombstone the entry so it disappears on ALL
 * devices after sync (the resolve-tombstones-everywhere property, proven against
 * the real `YjsCrdtMap` in `packages/crdt-yjs/test/inbox-convergence.test.ts`; the
 * single-replica `FakeCrdtMap` cannot prove convergence).
 */
export class Inbox {
  constructor(private readonly map: CrdtMap<InboxEntry>) {}

  /** Add (or LWW-replace) an entry. `entry.id` being deterministic keeps it idempotent. */
  add(entry: InboxEntry): void {
    this.map.set(entry.id, entry);
  }

  /** Live entries: everything minus tombstones (`deleted !== true`). */
  list(): InboxEntry[] {
    return this.map
      .entries()
      .map(([, v]) => v)
      .filter((e) => e.deleted !== true);
  }

  /**
   * Resolve an entry by tombstoning it: re-`set` the key with `deleted: true`. After
   * sync the tombstone propagates and the entry vanishes from `list()` everywhere.
   * A no-op if the id is unknown (we never materialise a tombstone for a ghost id).
   */
  resolve(id: string): void {
    const existing = this.map.get(id);
    if (existing === undefined) return;
    this.map.set(id, { ...existing, deleted: true });
  }

  /** Observe changes; the callback receives the changed entry ids. */
  observe(cb: (changedIds: string[]) => void): Unsubscribe {
    return this.map.observe(cb);
  }
}
