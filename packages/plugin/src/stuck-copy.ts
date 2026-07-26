/**
 * Copy for the "stuck" inbox row. Pure (no Obsidian imports) so the wording, which carries real
 * safety consequences, is unit-testable.
 *
 * WHY IT BRANCHES: there are two stuck classes and generic copy is WRONG for both. For a doc whose
 * content never arrived, "stopped syncing after repeated attempts" is false (this device never had
 * anything to send) and "reconnecting may clear this" promises a remedy that cannot work, which is
 * worse than silence: the user reconnects, nothing changes, and the plugin has lied once. For a doc
 * that IS on disk, the real fear is "did I lose my edit?", and there the honest answer is reassuring.
 * `onDisk` is the reliable signal that separates them.
 */

export interface StuckItemInfo {
  /** null when the docId has no index entry at all (a leftover record with no note). */
  path: string | null;
  /** Whether the file is actually present on THIS device's disk. */
  onDisk: boolean;
}

export interface StuckCopy {
  /** The explanation under the row heading. */
  sub: string;
  /** Manual-fix guidance, or null when no item admits that fix (wrong advice is worse than none). */
  fix: string | null;
}

/**
 * The manual fix, phrased as a two-branch FORK with the safe branch FIRST.
 *
 * A trailing precondition ("...then delete it. Only if no other device still has this file.") reads
 * as fine print and users execute recipes as they read them. Forking forces the user to classify
 * their own situation BEFORE reaching the destructive branch, and that branch's gate is an
 * affirmative condition they must verify rather than an exception they may skip. The consequence
 * sentence stays: the gate says when, the consequence says why the gate has teeth.
 */
const FIX_SINGLE =
  "Fix: if another device still has this note, sync it there and this clears on its own. " +
  "If it is gone from every device, create a note at this exact path, let it sync, then delete it. " +
  "If a copy still exists somewhere, doing this would delete it there.";

const FIX_MULTI =
  "Fix: if another device still has the note, sync it there and this clears on its own. " +
  "If it is gone from every device, create a note at the same path, let it sync, then delete it. " +
  "If a copy still exists somewhere, doing this would delete it there.";

/** Scoped by the item tag so the on-disk items in a mixed list are visibly excluded. */
const FIX_SCOPED =
  'Fix for "content never arrived": if another device still has the note, sync it there. ' +
  "If it is gone from every device, create a note at the same path, let it sync, then delete it. " +
  "If a copy still exists somewhere, this would delete it there.";

/** The per-item classifier tag in a multi-item list. Short: it is a label, not a sentence. */
export const TAG_NEVER_ARRIVED = "content never arrived";

export function stuckCopy(items: StuckItemInfo[]): StuckCopy {
  const absent = items.filter((i) => i.path !== null && !i.onDisk);
  const onDisk = items.filter((i) => i.onDisk);

  if (items.length === 1) {
    const [only] = items;
    if (only === undefined) return { sub: "", fix: null };
    if (only.path === null) {
      return {
        sub: "A leftover sync record with no note attached. It does not affect your files.",
        fix: null,
      };
    }
    if (only.onDisk) {
      return {
        sub:
          "Could not sync after repeated attempts. Your copy is safe on this device " +
          "and will sync when the connection recovers.",
        fix: null,
      };
    }
    // Cause, fault-absolution and the honest local answer to "is my data lost?" in one sentence.
    // It does NOT claim the data survives elsewhere, because this device cannot know that.
    return {
      sub:
        "Created on another device, but the content never arrived, " +
        "so there is nothing here to lose.",
      fix: FIX_SINGLE,
    };
  }

  if (onDisk.length === items.length) {
    return {
      sub:
        "Could not sync after repeated attempts. Your copies are safe on this device " +
        "and will sync when the connection recovers.",
      fix: null,
    };
  }
  if (absent.length === items.length) {
    return {
      sub:
        "Created on other devices, but the content never arrived, " +
        "so there is nothing here to lose.",
      fix: FIX_MULTI,
    };
  }
  return {
    sub: "Stopped syncing after repeated attempts.",
    fix: absent.length > 0 ? FIX_SCOPED : null,
  };
}
