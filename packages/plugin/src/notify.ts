import { Notice, setIcon } from "obsidian";
import {
  KIND_ICON,
  KIND_STICKY,
  type NotifyAction,
  type NotifyKind,
  type NotifyOptions,
} from "./notify-model.js";

/**
 * The ONE place the sticky/auto-dismiss rule lives. Both the `role="alert"` decision inside the
 * fragment and the duration handed to `new Notice` must derive from this single call: two copies
 * of the rule could drift, and a drifted `role="alert"` would silently stop matching whether the
 * notice actually stays put — invisible until someone hits it on a device, since this file imports
 * Obsidian and therefore has no unit test.
 */
const noticeDuration = (opts: NotifyOptions): number => opts.durationMs ?? KIND_STICKY[opts.kind];

/** Build the standardized notice DOM. `hide` closes over the live Notice (which may not exist
 *  yet at call time), so the action link can dismiss it. */
function buildNoticeFragment(
  opts: NotifyOptions,
  duration: number,
  hide: () => void,
): DocumentFragment {
  const iconName = opts.icon ?? KIND_ICON[opts.kind];
  return createFragment((f) => {
    const root = f.createDiv({ cls: ["zync-notice", `zync-notice--${opts.kind}`] });
    // Role follows the KIND, not the duration. `alert` is assertive and interrupts, which is right
    // for a problem and wrong for progress — and this notice re-renders every 8s, so an `alert`
    // would interrupt a screen reader on every poll for a whole first sync. Sticky-progress gets
    // `status` (polite). The old `duration === 0` predicate was only ever correct while sticky and
    // problem were the same set; the arriving notice is the first sticky that is not a problem.
    if (opts.kind === "warning" || opts.kind === "error") root.setAttribute("role", "alert");
    else if (duration === 0) root.setAttribute("role", "status");
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
        if (action.hideOnRun !== false) hide();
      });
    }
  });
}

/**
 * Build a standardized Notice: a Lucide icon accent + a word-first title, an optional detail line,
 * and an optional one-tap action link. Duration defaults by kind (warning/error sticky). Returns the
 * live Notice so callers can hold it (replace-in-place) or attach extra listeners.
 */
export function notify(opts: NotifyOptions): Notice {
  const duration = noticeDuration(opts);
  let notice: Notice;
  const frag = buildNoticeFragment(opts, duration, () => {
    notice.hide();
  });
  notice = new Notice(frag, duration);
  return notice;
}

/**
 * Re-render an EXISTING sticky in place via `Notice.setMessage` (Obsidian 1.13.1).
 *
 * Needed for any sticky whose content changes often. The hide-then-`new Notice` pattern used for
 * rarely-changing stickies would tear the toast down and re-animate it on every update, which for
 * a count polled every 8 seconds means dozens of re-animations during one first sync.
 */
export function updateNotice(notice: Notice, opts: NotifyOptions): void {
  notice.setMessage(
    buildNoticeFragment(opts, noticeDuration(opts), () => {
      notice.hide();
    }),
  );
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
