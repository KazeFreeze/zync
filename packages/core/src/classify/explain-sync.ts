// packages/core/src/classify/explain-sync.ts
import type { ConnStatus, VaultPath } from "../ports.js";
import { isConflictArtifactPath } from "../conflicts/artifact.js";
import { PROSE_EXT, ext } from "./classify.js";

export type SyncStatus = "syncing" | "pending" | "not-tracked" | "excluded";

/** v1's command produces only the first five. The rest are RESERVED for the deferred panel
 *  (see the spec Backlog) — keep the union open so the panel adds them without reshaping callers. */
export type ExcludeReason =
  | "trash"
  | "zync-internal"
  | "self-excluded"
  | "conflict-artifact"
  | "config-plane"
  | "category-off"
  | "plugin-not-opted-in"
  | "bundle-incomplete"
  | "version-held"
  | "config-not-in-scope"
  | "paused"
  | "not-vault-visible";

export type LivePlane = "prose" | "blob";
export type LiveState = "synced" | "pending" | "absent";
/** Alias of the transport's ConnStatus — kept identical (not re-declared) so a new transport state
 *  can't silently diverge from what engine.explain feeds in. */
export type ConnState = ConnStatus;

export interface ExplainFacts {
  /** Zync's OWN state-store prefix, i.e. `caps.configDir` (= ".obsidian/zync" in prod). No trailing slash needed. */
  zyncStorePrefix: string;
  /** Obsidian's config-dir prefix, WITH trailing slash (".obsidian/"). */
  obsidianConfigPrefix: string;
  plane: LivePlane;
  live: LiveState;
  /** A prose-extension file living on the blob plane (oversize / non-UTF-8 → not live-merged). */
  demotedProse: boolean;
  conn: ConnState;
}

/** A suggested one-tap fix the UI can surface as a link (never auto-run). The plugin maps the
 *  semantic token to an Obsidian command + label; keeping it a token keeps this core Obsidian-free. */
export type ExplainAction = "reverify";

export interface SyncExplanation {
  status: SyncStatus;
  reason?: ExcludeReason;
  /** The one-word verdict — the PRIMARY signal (word-first, not emoji). e.g. "Synced" / "Excluded". */
  title: string;
  /** One sentence of explanation. No leading word/marker: the UI renders title + an icon separately. */
  detail: string;
  /** Optional suggested fix; the UI shows it as a tappable link. */
  action?: ExplainAction;
}

function connSuffix(conn: ConnState): string {
  if (conn === "offline") return " You're currently offline, so it'll sync on reconnect.";
  if (conn === "connecting") return " Zync is reconnecting, so it'll sync once connected.";
  if (conn === "unauthorized")
    return " Zync can't authenticate to the relay. Check Settings, then Zync.";
  return "";
}

function blobQualifier(f: ExplainFacts): string {
  if (f.demotedProse)
    return " (synced as a blob, not live-merged: over the 1 MB cap or not valid UTF-8)";
  if (f.plane === "blob") return " (synced as an attachment/file)";
  return "";
}

/**
 * Explain the sync status of `path` for the active-file command. Pure — all live inputs are
 * pre-resolved into `f` by engine.explain(). Decision order is short-circuit; first match wins.
 * Returns STRUCTURED parts (title/detail/action); the plugin renders word + Lucide icon + link.
 */
export function explainSync(path: VaultPath, f: ExplainFacts): SyncExplanation {
  // ── excluded arms (order matters: specific store paths before the generic config arm) ──
  if (path.startsWith(".trash/")) {
    return {
      status: "excluded",
      reason: "trash",
      title: "Excluded",
      detail: "In the trash. Zync never syncs deleted-file storage.",
    };
  }
  if (path.startsWith(`${f.zyncStorePrefix}/`)) {
    return {
      status: "excluded",
      reason: "zync-internal",
      title: "Excluded",
      detail: "Zync's own state store, not synced.",
    };
  }
  if (isConflictArtifactPath(path)) {
    return {
      status: "excluded",
      reason: "conflict-artifact",
      title: "Excluded",
      detail:
        "A local conflict backup, kept on this device only so it doesn't multiply across your devices.",
    };
  }
  if (path.startsWith(`${f.obsidianConfigPrefix}plugins/zync/`)) {
    return {
      status: "excluded",
      reason: "self-excluded",
      title: "Excluded",
      detail: "Zync doesn't sync its own plugin files. Updates arrive through BRAT.",
    };
  }
  if (path.startsWith(f.obsidianConfigPrefix)) {
    return {
      status: "excluded",
      reason: "config-plane",
      title: "Excluded",
      detail:
        "An Obsidian config file. Zync syncs themes, snippets, and plugin code/settings through a separate channel.",
    };
  }

  // ── live status arms ──
  if (f.live === "absent") {
    return {
      status: "not-tracked",
      title: "Not tracked",
      detail: "Zync hasn't picked this up yet. It should sync shortly." + connSuffix(f.conn),
      action: "reverify",
    };
  }
  if (f.live === "pending") {
    return {
      status: "pending",
      title: "Pending",
      detail: "A change is in flight. Give it a moment." + connSuffix(f.conn),
    };
  }
  // synced — HEDGED copy (stamp-equality proves last-push-acked, not that the relay still holds it).
  // Deliberately does NOT call connSuffix: nothing is queued to reconnect-flush here, so the
  // "it'll sync on reconnect" wording would be misleading. The `tail` handles the offline case.
  const tail =
    f.conn === "connected"
      ? " If it's still missing on another device, that device hasn't caught up yet."
      : " If it's still missing on another device, it'll reconcile once this device is back online.";
  return {
    status: "syncing",
    title: "Synced",
    detail:
      "Nothing is holding this file back on this device: no local changes are waiting and the last push was acknowledged by the relay." +
      blobQualifier(f) +
      tail,
  };
}

export interface LiveInputs {
  hasLiveIndexEntry: boolean; // index.get(path) present & not deleted (PROSE plane)
  indexPending: boolean; // isPathPending(path) — only consulted when hasLiveIndexEntry
  hasBlobEntry: boolean; // blobEngine.manifestEntry(path) present (BLOB plane)
  blobOnDisk: boolean; // vault.read(path) !== null
  isProseExt: boolean; // path has a prose extension (md/markdown/txt)
}

export function isProseExtension(path: string): boolean {
  return PROSE_EXT.has(ext(path));
}

/**
 * Pure: resolve the (plane, live, demotedProse) triple that explainSync consumes. A live index entry
 * ⇒ the prose plane; otherwise the blob plane (present-in-manifest + on-disk). A prose-extension file
 * that landed on the blob plane was demoted (oversize / non-UTF-8) → flag it so the qualifier fires.
 */
export function resolveLiveState(
  i: LiveInputs,
): Pick<ExplainFacts, "plane" | "live" | "demotedProse"> {
  if (i.hasLiveIndexEntry) {
    return { plane: "prose", live: i.indexPending ? "pending" : "synced", demotedProse: false };
  }
  if (!i.hasBlobEntry) return { plane: "blob", live: "absent", demotedProse: false };
  return { plane: "blob", live: i.blobOnDisk ? "synced" : "pending", demotedProse: i.isProseExt };
}
