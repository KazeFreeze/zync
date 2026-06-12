import DiffMatchPatch from "diff-match-patch";
import { diff3Merge } from "node-diff3";
import type { TextEdit } from "../ports.js";

const dmp = new DiffMatchPatch();

/**
 * Compute a minimal char-level diff from oldText → newText and return it as
 * positional splice operations.  We intentionally NEVER produce a single
 * whole-text replace — the diff-match-patch DIFF_DELETE / DIFF_INSERT ops
 * are converted to `{at, delete, insert}` splices with an advancing cursor.
 */
export function diffToEdits(oldText: string, newText: string): TextEdit[] {
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  const edits: TextEdit[] = [];
  let cursor = 0;

  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      cursor += text.length;
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      // Deletion — check whether the previous edit was an INSERT at the same
      // position (produced by semantic cleanup reordering) and merge them.
      const prev = edits.at(-1);
      if (prev?.at === cursor && prev.delete === 0) {
        // Merge into a combined replace splice
        prev.delete = text.length;
      } else {
        edits.push({ at: cursor, delete: text.length, insert: "" });
      }
      cursor += text.length;
    } else {
      // DIFF_INSERT — check whether the previous edit is a deletion at the
      // same position so we can fold the insert into it.
      const prev = edits.at(-1);
      if (prev?.at === cursor && prev.insert === "") {
        prev.insert = text;
      } else {
        edits.push({ at: cursor, delete: 0, insert: text });
      }
      // cursor does NOT advance on INSERT (text was not present in old)
    }
  }

  return edits;
}

/**
 * Apply a set of positional splice operations to `text`.
 * Ops are sorted by `at` descending so that earlier offsets are not
 * invalidated by ops applied at later positions.
 */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  for (const { at, delete: del, insert } of sorted) {
    text = text.slice(0, at) + insert + text.slice(at + del);
  }
  return text;
}

export interface Merge3Result {
  merged: string;
  clean: boolean;
}

/**
 * Line-based three-way merge.
 *
 * Splits each text into lines (preserving trailing-newline semantics via a
 * trailing empty string), performs a structural diff3 merge, and joins the
 * result back.
 *
 * On conflict the call is NOT-clean and `merged` is set to the CRDT version
 * so the caller can preserve in-memory state while the disk artifact is
 * saved separately.
 */
export function merge3(base: string, disk: string, crdt: string): Merge3Result {
  const baseLines = base.split("\n");
  const diskLines = disk.split("\n");
  const crdtLines = crdt.split("\n");

  // diff3Merge(a, o, b) — disk is "a", base is "o", crdt is "b"
  const regions = diff3Merge(diskLines, baseLines, crdtLines, {
    excludeFalseConflicts: true,
  });

  let hasConflict = false;
  const resultLines: string[] = [];

  for (const region of regions) {
    if (region.ok !== undefined) {
      resultLines.push(...region.ok);
    } else if (region.conflict !== undefined) {
      hasConflict = true;
      // On conflict we don't accumulate conflict markers; just flag it.
      // The caller will use `crdt` as the authoritative in-memory text.
    }
  }

  if (hasConflict) {
    return { merged: crdt, clean: false };
  }

  return { merged: resultLines.join("\n"), clean: true };
}
