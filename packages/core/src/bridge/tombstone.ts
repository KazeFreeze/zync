import type { Route } from "../classify/classify.js";
import type { DeviceId, DocId, Sha256, VaultPath } from "../ports.js";
import type { TreeEntry } from "../protocol/index-doc.js";
import { IndexDoc } from "../protocol/index-doc.js";
import { makeStamp, stampHash } from "../protocol/stamp.js";

/**
 * Tombstones — EDIT-BEATS-DELETE (0b-2 §B).
 *
 * A delete must NOT be a bare key-drop. If a delete on device A races a content
 * edit on device B (both offline), a key-drop would silently win and the edit's
 * content would be lost forever. Instead a delete lays a TOMBSTONE that REMEMBERS
 * the content hash AT DELETE TIME. After the partition heals, every replica can
 * compare that remembered hash against the note's CURRENT content hash:
 *   - unchanged  → the delete was uncontested → confirm the delete;
 *   - changed    → a concurrent edit happened after the delete-time snapshot →
 *                  RESURRECT the note at the edited content (never lose content).
 *
 * This module is yjs-free (it lives in `@zync/core`): it works only through the
 * {@link IndexDoc} port and the pure {@link stampHash}/{@link makeStamp} stamp
 * utilities. Real-CRDT convergence (two replicas resurrecting identically) is
 * proven in `packages/crdt-yjs/test/tombstone-rename-convergence.test.ts`.
 */

/**
 * Lay a tombstone that remembers the content hash at delete time (for
 * edit-beats-delete). The entry keeps `docId`/`type` and carries
 * `stamp = makeStamp(contentSha, deviceId)` with `deleted: true`, so a later
 * resolve can compare the recorded hash against the note's current content.
 */
export function recordTombstone(
  index: IndexDoc,
  path: VaultPath,
  docId: DocId,
  type: Route,
  deviceId: DeviceId,
  contentSha: Sha256,
): void {
  index.setTombstone(path, {
    docId,
    type,
    stamp: makeStamp(contentSha, deviceId),
    deleted: true,
  });
}

/**
 * Decide a tombstoned path's fate given the note's CURRENT content hash. Compares
 * the HASH PART only (the device suffix is never an equality input — see the
 * keystone rule in {@link stampHash}): if the doc was edited after the delete
 * (`currentSha` ≠ the tombstone's recorded hash) → `"resurrect"`; otherwise the
 * delete was uncontested → `"delete"`.
 */
export function resolveTombstone(tombstone: TreeEntry, currentSha: Sha256): "delete" | "resurrect" {
  return stampHash(tombstone.stamp) === currentSha ? "delete" : "resurrect";
}

/** A notice surfaced to the user's inbox. Task 9 wires the real inbox; here it is a seam. */
export interface ResurrectedNotice {
  kind: "resurrected";
  path: VaultPath;
  docId: DocId;
}

/**
 * Apply a resurrection: re-set the index entry LIVE at the doc's CURRENT content
 * (same `docId`/`type` — content continuity), and signal an inbox notice so the
 * user learns the note came back. `onInboxNotice` is a seam (Task 9 wires the
 * real inbox).
 */
export function applyResurrection(
  index: IndexDoc,
  path: VaultPath,
  tombstone: TreeEntry,
  currentSha: Sha256,
  onInboxNotice: (n: ResurrectedNotice) => void,
): void {
  index.setStamp(path, tombstone.docId, tombstone.type, currentSha);
  onInboxNotice({ kind: "resurrected", path, docId: tombstone.docId });
}
