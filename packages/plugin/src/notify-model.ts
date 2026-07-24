import type { SyncStatus } from "@zync/core";

/** Severity kind -> drives icon, default sticky duration, and the CSS accent class. */
export type NotifyKind = "success" | "info" | "warning" | "error";

/** A one-tap action link inside a Notice. Never auto-runs; the renderer wires
 *  preventDefault + stopPropagation + notice.hide() around `run`. */
export interface NotifyAction {
  label: string;
  run: () => void;
  /** If false, the notice stays open after the action runs (default: hide). */
  hideOnRun?: boolean;
}

export interface NotifyOptions {
  kind: NotifyKind;
  /** The one-word primary signal (word-first). */
  title: string;
  detail?: string;
  action?: NotifyAction;
  /** Override the kind->duration default. 0 = sticky. */
  durationMs?: number;
  /** Override the kind->icon default (e.g. the explain command's 4 distinct icons). */
  icon?: string;
}

/** kind -> Lucide icon name. */
export const KIND_ICON: Record<NotifyKind, string> = {
  success: "check-circle",
  info: "info",
  warning: "alert-triangle",
  error: "x-circle",
};

/** kind -> default duration (ms). 0 = sticky. Problems stay until tapped. */
export const KIND_STICKY: Record<NotifyKind, number> = {
  success: 4000,
  info: 4000,
  warning: 0,
  error: 0,
};

/**
 * Map an explainSync verdict's status to notify props. Non-synced verdicts are STICKY (durationMs 0)
 * so Pending/Not-tracked/Excluded stay readable (and the not-tracked action link doesn't live in a
 * disappearing toast). `info` kind gives a MUTED icon, so an intentional exclusion isn't shown as a
 * fault. Synced auto-dismisses with a green check.
 */
export function explainNotifyProps(status: SyncStatus): {
  kind: NotifyKind;
  icon: string;
  durationMs: number;
} {
  switch (status) {
    case "syncing":
      return { kind: "success", icon: "check-circle", durationMs: 4000 };
    case "pending":
      return { kind: "info", icon: "clock", durationMs: 0 };
    case "not-tracked":
      return { kind: "info", icon: "help-circle", durationMs: 0 };
    case "excluded":
      return { kind: "info", icon: "ban", durationMs: 0 };
  }
}
