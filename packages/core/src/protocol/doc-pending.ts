import type { Stamp } from "../ports.js";
import { stampsEqual } from "./stamp.js";

/**
 * Pure per-live-entry pending predicate — the exact clause SyncEngine.pendingDocs() applies to each
 * live index entry, lifted out so it is unit-testable without an engine. A doc is pending iff its
 * index stamp differs from the durable synced stamp (not yet acked by the relay) OR from the on-disk
 * content hash (content not yet materialized to disk). Uses hash-only equality via stampsEqual; `null`
 * models "no synced stamp yet" / "file absent on disk".
 */
export function isDocStampPending(
  entryStamp: Stamp,
  syncedStamp: Stamp | null,
  diskHash: Stamp | null,
): boolean {
  if (!stampsEqual(entryStamp, syncedStamp)) return true;
  if (!stampsEqual(entryStamp, diskHash)) return true;
  return false;
}
