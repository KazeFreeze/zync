import type { CrdtMap, DocId, Sha256, Unsubscribe, VaultPath } from "../ports.js";

export type InboxKind =
  | "conflict"
  | "resurrected"
  | "supervised-import"
  | "pending-delete"
  | "config-file";

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
  localSha?: Sha256;
  remoteSha?: Sha256;
  localSize?: number;
  remoteSize?: number;

  // ── PROVENANCE (stamped in Inbox.add; see InboxProvenance) ──────────────────────────────────
  /** ms epoch at which this entry was created. */
  at?: number;
  /** The device that DETECTED this — conflicts are detected locally, then synced to everyone. */
  byDeviceId?: string;
  byDeviceName?: string;
  /** Was that device's transport connected at detection? */
  connected?: boolean;
  /** Had the shared index actually synced at detection, or were we deciding against a stale view? */
  indexSynced?: boolean;
}

/**
 * Context captured at the moment an entry is created.
 *
 * WHY: the inbox is SYNCED, so an entry created on one device shows up on all of them. Without
 * this, "conflicts on my phone" is indistinguishable from "conflicts my desktop made, displayed on
 * my phone" — a distinction that took an hour of reverse-engineering timestamps out of generated
 * filenames to establish on a real vault.
 *
 * `connected` and `indexSynced` are the load-bearing pair: they separate a LEGITIMATE divergence
 * (two devices genuinely edited the same base) from conflicting against state we had simply not
 * received yet.
 */
export interface InboxProvenance {
  at: number;
  byDeviceId: string;
  byDeviceName?: string;
  connected?: boolean;
  indexSynced?: boolean;
}

/**
 * A synced inbox over a `CrdtMap<InboxEntry>` (per-entry LWW register, keyed by
 * {@link InboxEntry.id}). Resolving = tombstone the entry so it disappears on ALL
 * devices after sync (the resolve-tombstones-everywhere property, proven against
 * the real `YjsCrdtMap` in `packages/crdt-yjs/test/inbox-convergence.test.ts`; the
 * single-replica `FakeCrdtMap` cannot prove convergence).
 */
export class Inbox {
  constructor(
    private readonly map: CrdtMap<InboxEntry>,
    /** Supplies {@link InboxProvenance} at creation time. Optional so existing callers stay valid. */
    private readonly stamp?: () => InboxProvenance,
  ) {}

  /**
   * Add (or LWW-replace) an entry. `entry.id` being deterministic keeps it idempotent.
   *
   * Provenance is stamped HERE rather than at the ~7 call sites, so an entry cannot be created
   * without it. Explicit caller-set fields always win — the stamp only fills what is missing.
   */
  add(entry: InboxEntry): void {
    const p = this.stamp?.();
    const stamped: InboxEntry =
      p === undefined
        ? entry
        : {
            at: p.at,
            byDeviceId: p.byDeviceId,
            ...(p.byDeviceName !== undefined ? { byDeviceName: p.byDeviceName } : {}),
            ...(p.connected !== undefined ? { connected: p.connected } : {}),
            ...(p.indexSynced !== undefined ? { indexSynced: p.indexSynced } : {}),
            ...entry, // caller-set fields win
          };
    this.map.set(entry.id, stamped);
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

  /**
   * Resolve MANY ids as one atomic batch. Bulk dismissal used to call {@link resolve} in a tight
   * loop, so a large inbox became N CRDT transactions AND N observer cascades on the main thread —
   * which froze Obsidian. Batching collapses that to ONE transaction and ONE observer fire.
   * Falls back to the per-id path when the map has no `transact` seam (unchanged behaviour).
   */
  resolveMany(ids: readonly string[]): void {
    const run = (): void => {
      for (const id of ids) this.resolve(id);
    };
    if (this.map.transact !== undefined) this.map.transact(run);
    else run();
  }

  /** Observe changes; the callback receives the changed entry ids. */
  observe(cb: (changedIds: string[]) => void): Unsubscribe {
    return this.map.observe(cb);
  }
}
