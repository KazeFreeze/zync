import type { InboxEntry } from "./inbox.js";

export type EntryAction =
  | "open-current"
  | "open-backup"
  | "keep-current"
  | "keep-backup"
  | "confirm-delete"
  | "keep"
  | "acknowledge";

export interface EntryActionSpec {
  action: EntryAction;
  label: string;
  /** A destructive/overwriting choice — the UI should style it as a warning. */
  danger?: boolean;
  /** The safe/default choice — the UI may emphasise it. */
  primary?: boolean;
}

export interface EntryView {
  /** Short badge text derived from the entry's true nature (not the raw `kind`). */
  kindLabel: string;
  /** One-line human summary of what happened. */
  title: string;
  actions: EntryActionSpec[];
}

/** A content conflict is one that parked a backup (`artifactPath`) under a mergeable kind. */
function isContentConflict(e: InboxEntry): boolean {
  return e.artifactPath !== undefined && (e.kind === "conflict" || e.kind === "supervised-import");
}

/**
 * Entries that need a user DECISION (vs informational FYIs). Drives the status-bar badge count so a
 * pile of "restored"/"rename refused" notices does not inflate a scary conflict number.
 */
export function isActionableConflict(e: InboxEntry): boolean {
  return isContentConflict(e) || e.kind === "pending-delete";
}

/**
 * Map an inbox entry to its UI view. Actions derive from SHAPE (artifactPath presence +
 * artifactLocal); labels from `kind`. Unknown shapes fall through to acknowledge-only — a future
 * kind can never wedge the UI.
 */
export function describeInboxEntry(e: InboxEntry, ctx: { artifactLocal: boolean }): EntryView {
  if (isContentConflict(e)) {
    if (!ctx.artifactLocal) {
      return {
        kindLabel: e.kind === "supervised-import" ? "import" : "conflict",
        title: e.detail ?? "A conflict backup exists on another device.",
        actions: [
          { action: "open-current", label: "Open note" },
          { action: "acknowledge", label: "Dismiss" },
        ],
      };
    }
    if (e.kind === "supervised-import") {
      return {
        kindLabel: "import",
        title: e.detail ?? "First sync found a different version on the server.",
        actions: [
          { action: "open-current", label: "Open server copy" },
          { action: "open-backup", label: "Open my copy" },
          { action: "keep-current", label: "Keep imported server copy", primary: true },
          { action: "keep-backup", label: "Restore my local copy", danger: true },
          { action: "acknowledge", label: "Dismiss" },
        ],
      };
    }
    return {
      kindLabel: "conflict",
      title: e.detail ?? "Your local edit was demoted to a backup; the synced version is live.",
      actions: [
        { action: "open-current", label: "Open current" },
        { action: "open-backup", label: "Open backup" },
        { action: "keep-current", label: "Keep current", primary: true },
        { action: "keep-backup", label: "Keep backup", danger: true },
        { action: "acknowledge", label: "Dismiss" },
      ],
    };
  }

  if (e.kind === "pending-delete") {
    return {
      kindLabel: "delete?",
      title: e.detail ?? "Deleted on another device. Delete it here too, or keep it?",
      actions: [
        { action: "open-current", label: "Open note" },
        { action: "confirm-delete", label: "Confirm delete", danger: true },
        { action: "keep", label: "Keep" },
      ],
    };
  }

  if (e.kind === "resurrected") {
    return {
      kindLabel: "restored",
      title: e.detail ?? "Edited after a delete, so it was restored (nothing lost).",
      actions: [
        { action: "open-current", label: "Open note" },
        { action: "acknowledge", label: "Acknowledge" },
      ],
    };
  }

  // conflict kind WITHOUT artifactPath: informational notices.
  if (e.id === "blob:sync-failed") {
    return {
      kindLabel: "sync",
      title: e.detail ?? "Some files could not sync; retrying.",
      actions: [],
    };
  }
  if (e.id.startsWith("conflict:rename-refused:")) {
    return {
      kindLabel: "rename",
      title: e.detail ?? "A rename was refused.",
      actions: [{ action: "acknowledge", label: "Dismiss" }],
    };
  }
  // recovered-file notices (recoverInPlaceCollision / orphan-sweep): path IS a real file.
  return {
    kindLabel: "recovered",
    title: e.detail ?? "A note was recovered.",
    actions: [
      { action: "open-current", label: "Open note" },
      { action: "acknowledge", label: "Acknowledge" },
    ],
  };
}
