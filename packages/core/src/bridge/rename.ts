import type { DocId, VaultPath } from "../ports.js";
import { IndexDoc } from "../protocol/index-doc.js";

/**
 * Renames — docId CONTINUITY + divergent-rename DETERMINISM (0b-2 §B).
 *
 * A rename is a pure index operation: it moves the index key but PRESERVES the
 * {@link DocId}, so the note's CRDT doc (its content/history) is untouched — the
 * document's identity survives the rename.
 *
 * DIVERGENT RENAME: two devices can, while partitioned, rename the SAME docId to
 * DIFFERENT paths. After the index converges the tree ends with multiple LIVE
 * keys pointing at one docId. We resolve this DETERMINISTICALLY so every replica
 * computes the same winner with no coordination: the winner is the
 * lexicographically-smallest path; the losers are tombstoned. Because all keys
 * share the same docId/content, no content is lost — the replicas merely
 * converge on a single name.
 *
 * BACKLINK REWRITES: when `a.md` is renamed, Obsidian rewrites `[[a]]`→`[[b]]`
 * inside OTHER notes. Those are ordinary `modify` events on those notes; they
 * flow through the existing INGEST pipeline under the all-events echo discipline.
 * There is NO special handling here and NO separate path — backlink edits are
 * just content edits like any other.
 *
 * This module is yjs-free (`@zync/core`): it works only through the
 * {@link IndexDoc} port. Real-CRDT convergence (both replicas converging on the
 * same deterministic winner) is proven in
 * `packages/crdt-yjs/test/tombstone-rename-convergence.test.ts`.
 */

/**
 * Rename preserves the docId (content continuity) — the note's CRDT doc is
 * untouched. Delegates to {@link IndexDoc.rename}, which re-keys the entry with
 * the SAME docId and tombstones the old key.
 */
export function applyRename(index: IndexDoc, from: VaultPath, to: VaultPath): void {
  index.rename(from, to);
}

/**
 * Resolve a divergent rename DETERMINISTICALLY: given all the live paths bound to
 * one docId, the winner is the lexicographically-smallest path and the losers are
 * the rest. Every replica passes the same set (post-convergence) and so computes
 * the identical winner — no coordination, no split.
 */
export function resolveRenameConflict(pathsForDocId: VaultPath[]): {
  winner: VaultPath;
  losers: VaultPath[];
} {
  const sorted = [...pathsForDocId].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const winner = sorted[0];
  if (winner === undefined) {
    throw new Error("resolveRenameConflict: no paths to resolve");
  }
  return { winner, losers: sorted.slice(1) };
}

/**
 * Find all LIVE paths bound to `docId`; if more than one, keep the deterministic
 * winner live and tombstone (delete) the loser keys, returning the decision.
 * Returns `null` when there is no conflict (≤1 live key). IDEMPOTENT: once the
 * losers are tombstoned, a second run finds only the winner live → `null`, so
 * every replica can run it freely and converge.
 */
export function applyRenameConflictResolution(
  index: IndexDoc,
  docId: DocId,
): { winner: VaultPath; losers: VaultPath[] } | null {
  const livePaths = index
    .liveEntries()
    .filter(([, e]) => e.docId === docId)
    .map(([p]) => p);
  if (livePaths.length <= 1) return null;

  const { winner, losers } = resolveRenameConflict(livePaths);
  for (const loser of losers) index.delete(loser);
  return { winner, losers };
}
