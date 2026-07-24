import { Notice, setIcon } from "obsidian";
import {
  KIND_ICON,
  KIND_STICKY,
  type NotifyAction,
  type NotifyKind,
  type NotifyOptions,
} from "./notify-model.js";

/**
 * Build a standardized Notice: a Lucide icon accent + a word-first title, an optional detail line,
 * and an optional one-tap action link. Duration defaults by kind (warning/error sticky). Returns the
 * live Notice so callers can hold it (replace-in-place) or attach extra listeners.
 */
export function notify(opts: NotifyOptions): Notice {
  const duration = opts.durationMs ?? KIND_STICKY[opts.kind];
  const iconName = opts.icon ?? KIND_ICON[opts.kind];
  let notice: Notice;
  const frag = createFragment((f) => {
    const root = f.createDiv({ cls: ["zync-notice", `zync-notice--${opts.kind}`] });
    if (duration === 0) root.setAttribute("role", "alert"); // sticky problem -> announce to a11y tools
    const head = root.createDiv({ cls: "zync-notice-head" });
    setIcon(head.createSpan({ cls: "zync-notice-icon" }), iconName);
    head.createSpan({ cls: "zync-notice-title", text: opts.title });
    if (opts.detail !== undefined) root.createDiv({ cls: "zync-notice-detail", text: opts.detail });
    const action = opts.action;
    if (action !== undefined) {
      const link = root.createEl("a", { cls: "zync-notice-action", text: action.label, href: "#" });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation(); // a tap anywhere on a Notice dismisses it; keep the link independent
        action.run();
        if (action.hideOnRun !== false) notice.hide();
      });
    }
  });
  notice = new Notice(frag, duration);
  return notice;
}

export const notifySuccess = (title: string, detail?: string, action?: NotifyAction): Notice =>
  notify({
    kind: "success",
    title,
    ...(detail !== undefined && { detail }),
    ...(action !== undefined && { action }),
  });
export const notifyInfo = (title: string, detail?: string, action?: NotifyAction): Notice =>
  notify({
    kind: "info",
    title,
    ...(detail !== undefined && { detail }),
    ...(action !== undefined && { action }),
  });
export const notifyWarning = (title: string, detail?: string, action?: NotifyAction): Notice =>
  notify({
    kind: "warning",
    title,
    ...(detail !== undefined && { detail }),
    ...(action !== undefined && { action }),
  });
export const notifyError = (title: string, detail?: string, action?: NotifyAction): Notice =>
  notify({
    kind: "error",
    title,
    ...(detail !== undefined && { detail }),
    ...(action !== undefined && { action }),
  });
