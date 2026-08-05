import type { InboxEntry } from "./inbox.js";

export type EntryAction =
  | "open-current"
  | "open-backup"
  | "keep-current"
  | "keep-backup"
  | "confirm-delete"
  | "keep"
  | "acknowledge"
  | "keep-mine"
  | "keep-theirs";

/** Extract the filename component from a vault path (e.g. ".obsidian/snippets/x.css" → "x.css"). */
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

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
  return isContentConflict(e) || e.kind === "pending-delete" || e.kind === "config-file";
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
  if (e.kind === "config-file") {
    return {
      kindLabel: "Config file",
      title: basename(e.path),
      actions: [
        { action: "keep-mine", label: "Keep mine", primary: true },
        { action: "keep-theirs", label: "Keep synced" },
      ],
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

/**
 * A human line explaining WHERE a conflict came from, or null when the entry predates provenance.
 *
 * Two things it must convey, because they are the ones people get wrong:
 *
 *  1. WHICH DEVICE detected it. The inbox is a SYNCED map, so a conflict created on a desktop
 *     appears on the phone too. Without this, "my phone keeps conflicting" is indistinguishable
 *     from "my desktop conflicts and my phone is showing me". On a real vault, 285 of 288 entries
 *     turned out to come from one desktop; the phone had made two.
 *  2. WHETHER THAT DEVICE COULD SEE THE OTHERS. A device that was offline, or whose index had not
 *     synced, may have conflicted against state it simply had not received. That is a connectivity
 *     problem wearing a conflict's clothes, and it needs a completely different fix.
 */
export function provenanceLine(e: InboxEntry): string | null {
  if (e.byDeviceId === undefined && e.byDeviceName === undefined && e.at === undefined) return null;

  const who = e.byDeviceName ?? e.byDeviceId ?? "an unknown device";
  const when = e.at === undefined ? "" : ` on ${new Date(e.at).toLocaleString()}`;

  // Only mention connectivity when it is EXCULPATORY for the merge logic — i.e. when this device
  // could not have known about the other side. Saying "was online" on every healthy conflict is
  // noise that trains people to ignore the line.
  let caveat = "";
  if (e.connected === false) {
    caveat = " while it was offline, so it could not see other devices' changes";
  } else if (e.indexSynced === false) {
    caveat = " while it was still catching up, so it may not have received other devices' changes";
  }

  return `Detected by ${who}${when}${caveat}.`;
}
