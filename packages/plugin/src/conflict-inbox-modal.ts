import { Modal, TFile, setIcon, setTooltip, type App } from "obsidian";
import { notify, notifySuccess, notifyInfo, notifyError } from "./notify.js";
import {
  SyncEngine,
  describeInboxEntry,
  ArtifactNotLocalError,
  type EntryAction,
  type EntryView,
  type InboxEntry,
  type VaultPath,
} from "@zync/core";

/** The basename (last path segment) — a friendlier heading than the full vault path. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Short, kind-specific copy for a content conflict (live "synced" side vs parked "mine" side). */
function framing(kind: InboxEntry["kind"]): {
  sub: string;
  keepCurrent: string;
  keepBackup: string;
  openCurrent: string;
  openBackup: string;
} {
  if (kind === "supervised-import") {
    return {
      sub: "The server copy is live; your local copy is backed up.",
      keepCurrent: "Keep server",
      keepBackup: "Keep mine",
      openCurrent: "Open server",
      openBackup: "Open mine",
    };
  }
  if (kind === "config-file") {
    return {
      sub: "Config file changed on another device.",
      keepCurrent: "Keep synced",
      keepBackup: "Keep mine",
      openCurrent: "Open synced",
      openBackup: "Open mine",
    };
  }
  return {
    sub: "The synced version is live; your edit is backed up.",
    keepCurrent: "Keep synced",
    keepBackup: "Keep mine",
    openCurrent: "Open synced",
    openBackup: "Open mine",
  };
}

const isContentConflict = (view: EntryView): boolean =>
  view.actions.some((a) => a.action === "keep-current") &&
  view.actions.some((a) => a.action === "keep-backup");

/**
 * Browse + resolve the engine's conflict inbox. Opened on demand (no persistent leaf).
 *
 * One compact row per entry: content conflicts get inline "Keep synced / Keep mine" + Open links;
 * other kinds (pending-delete, resurrected, notices) get their kind-specific actions. A bulk bar
 * appears when there are several items ("Keep synced for all", "Dismiss all"). All presentation is
 * here; `describeInboxEntry` (in @zync/core) supplies the semantics.
 */
export class ConflictInboxModal extends Modal {
  private readonly engine: SyncEngine;
  private unsub: (() => void) | null = null;

  constructor(app: App, engine: SyncEngine) {
    super(app);
    this.engine = engine;
  }

  override onOpen(): void {
    this.titleEl.setText("Sync inbox");
    this.modalEl.addClass("zync-inbox-modal");
    this.unsub = this.engine.inbox.observe(() => this.render());
    this.render();
  }

  override onClose(): void {
    this.unsub?.();
    this.unsub = null;
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const entries = this.engine.inbox.list();
    // STUCK is read straight from the engine, NOT from the inbox: the inbox is a SYNCED CrdtMap and
    // stuck-ness is device-local (a peer holding the content is not stuck, and a dismiss there would
    // flap against this device). Rendering it synthetically also keeps it out of "Dismiss all".
    const stuck = this.engine.stuckDocs();

    if (entries.length === 0 && stuck.length === 0) {
      const empty = contentEl.createDiv({ cls: "zync-empty" });
      setIcon(empty.createDiv({ cls: "zync-empty-icon" }), "check-circle");
      empty.createEl("p", { cls: "zync-empty-title", text: "You're all caught up" });
      empty.createEl("p", {
        cls: "zync-empty-sub",
        text: "Nothing to review. Every note is in sync.",
      });
      return;
    }

    if (stuck.length > 0) this.renderStuckSection(contentEl, stuck);
    if (entries.length === 0) return;

    // Resolve each entry's view once (drives both the rows and the bulk bar).
    const items = entries.map((entry) => {
      const artifactLocal =
        entry.artifactPath !== undefined &&
        this.app.vault.getAbstractFileByPath(entry.artifactPath) instanceof TFile;
      return { entry, view: describeInboxEntry(entry, { artifactLocal }) };
    });

    this.renderTopBar(contentEl, items);

    const list = contentEl.createDiv({ cls: "zync-list" });
    for (const { entry, view } of items) this.renderRow(list, entry, view);
  }

  private renderTopBar(parent: HTMLElement, items: { entry: InboxEntry; view: EntryView }[]): void {
    const bar = parent.createDiv({ cls: "zync-topbar" });
    const n = items.length;
    bar.createSpan({ cls: "zync-count", text: `${String(n)} item${n === 1 ? "" : "s"} to review` });

    const contentIds = items.filter((i) => isContentConflict(i.view)).map((i) => i.entry.id);
    if (n < 2) return; // no bulk actions worth showing for a single item

    const actions = bar.createDiv({ cls: "zync-topbar-actions" });
    if (contentIds.length >= 2) {
      const keep = actions.createEl("button", {
        cls: "zync-btn zync-btn-sm",
        text: `Keep synced for all (${String(contentIds.length)})`,
      });
      keep.onclick = () => void this.bulkKeepSynced(contentIds);
    }
    const dismiss = actions.createEl("button", {
      cls: "zync-btn zync-btn-sm zync-btn-link",
      text: "Dismiss all",
    });
    dismiss.onclick = () => {
      this.bulkDismiss(items.map((i) => i.entry.id));
    };
  }

  /**
   * The STUCK section: a REPORT, not a chooser. A conflict row promises a decision with two safe
   * buttons; these items may have NO available action, so they get no primary button (a fake CTA
   * teaches users that buttons are decorative). Every stuck path is listed (the set is small by
   * construction, bounded by the self-heal latch) rather than sampled, since this is the detail
   * surface. "Open" appears only for a path that actually exists on disk.
   */
  private renderStuckSection(
    parent: HTMLElement,
    stuck: { docId: string; path: string | null }[],
  ): void {
    const list = parent.createDiv({ cls: "zync-list" });
    const row = list.createDiv({ cls: "zync-row" });

    const main = row.createDiv({ cls: "zync-row-main" });
    const label = main.createDiv({ cls: "zync-row-label" });
    const chip = label.createSpan({ cls: "zync-chip", text: "stuck" });
    chip.dataset.kind = "stuck";
    // Repeat the DOC count here: the status bar counts docs, so a single row must not read as "1".
    label.createSpan({
      cls: "zync-row-name",
      text: stuck.length === 1 ? "1 item stuck" : `${String(stuck.length)} items stuck`,
    });

    const sub = row.createDiv({ cls: "zync-row-sub" });
    sub.createSpan({
      text: "Stopped syncing after repeated attempts. Reconnecting may clear this. ",
    });

    const SHOWN = 10;
    for (const s of stuck.slice(0, SHOWN)) {
      const line = sub.createDiv({ cls: "zync-row-sub" });
      if (s.path === null) {
        // No index entry: an untracked leftover. Never render a blank name.
        line.createSpan({ text: `Untracked entry (${s.docId.slice(0, 8)})` });
        continue;
      }
      line.createSpan({ text: `${baseName(s.path)} ` });
      const onDisk = this.app.vault.getAbstractFileByPath(s.path) instanceof TFile;
      if (onDisk) {
        const path = s.path;
        const a = line.createEl("a", { cls: "zync-inline-link", text: "Open", href: "#" });
        a.onclick = (e): void => {
          e.preventDefault();
          void this.app.workspace.openLinkText(path, "", false);
        };
      } else {
        // The defining symptom of the common class: the entry exists but its content never arrived.
        line.createSpan({ cls: "zync-row-sub", text: "waiting for content that never arrived" });
      }
    }
    if (stuck.length > SHOWN) {
      sub.createDiv({ cls: "zync-row-sub", text: `+${String(stuck.length - SHOWN)} more` });
    }
  }

  private renderRow(parent: HTMLElement, entry: InboxEntry, view: EntryView): void {
    const row = parent.createDiv({ cls: "zync-row" });

    const main = row.createDiv({ cls: "zync-row-main" });
    const label = main.createDiv({ cls: "zync-row-label" });
    const chip = label.createSpan({ cls: "zync-chip", text: view.kindLabel });
    chip.dataset.kind = entry.kind;
    const name = label.createSpan({ cls: "zync-row-name", text: baseName(entry.path) });
    name.title = entry.path;

    const act = main.createDiv({ cls: "zync-row-act" });
    const sub = row.createDiv({ cls: "zync-row-sub" });

    if (isContentConflict(view)) {
      const f = framing(entry.kind);
      this.button(act, f.keepCurrent, "keep-current", entry, { cta: true });
      this.button(act, f.keepBackup, "keep-backup", entry, {});
      sub.createSpan({ text: `${f.sub} ` });
      this.iconLink(sub, "cloud", f.openCurrent, "open-current", entry);
      this.iconLink(sub, "hard-drive", f.openBackup, "open-backup", entry);
      sub.createSpan({ cls: "zync-dot", text: "·" });
      this.link(sub, "Leave for now", "acknowledge", entry);
      return;
    }

    // Non-chooser kinds: primary actions inline, Open/Acknowledge as links in the sub-line.
    sub.createSpan({ text: `${view.title} ` });
    for (const spec of view.actions) {
      if (spec.action === "open-current" || spec.action === "open-backup") {
        const icon = spec.action === "open-current" ? "cloud" : "hard-drive";
        this.iconLink(sub, icon, spec.label, spec.action, entry);
      } else {
        this.button(act, spec.label, spec.action, entry, {
          cta: spec.primary === true,
          danger: spec.danger === true,
        });
      }
    }
    if (view.actions.length === 0) sub.createSpan({ text: "Retrying automatically…" });
  }

  private button(
    parent: HTMLElement,
    text: string,
    action: EntryAction,
    entry: InboxEntry,
    style: { cta?: boolean; danger?: boolean },
  ): void {
    const b = parent.createEl("button", { text, cls: "zync-btn zync-btn-sm" });
    if (style.cta === true) b.addClass("mod-cta");
    if (style.danger === true) b.addClass("mod-warning");
    b.onclick = () => void this.act(action, entry.id, entry.path, entry.artifactPath);
  }

  private link(parent: HTMLElement, text: string, action: EntryAction, entry: InboxEntry): void {
    const a = parent.createEl("a", { cls: "zync-inline-link", text, href: "#" });
    a.onclick = (e) => {
      e.preventDefault();
      void this.act(action, entry.id, entry.path, entry.artifactPath);
    };
  }

  /** A compact icon variant of {@link link} — the label becomes the tooltip + aria-label. */
  private iconLink(
    parent: HTMLElement,
    iconName: string,
    tooltip: string,
    action: EntryAction,
    entry: InboxEntry,
  ): void {
    const a = parent.createEl("a", { cls: "zync-inline-link zync-icon-link", href: "#" });
    setIcon(a, iconName);
    setTooltip(a, tooltip);
    a.setAttribute("aria-label", tooltip);
    a.onclick = (e) => {
      e.preventDefault();
      void this.act(action, entry.id, entry.path, entry.artifactPath);
    };
  }

  private async bulkKeepSynced(ids: string[]): Promise<void> {
    let ok = 0;
    for (const id of ids) {
      try {
        await this.engine.resolveContentConflict(id, "keep-current");
        ok++;
      } catch {
        // skip an entry that raced away / lost its artifact; the count reflects what applied.
      }
    }
    notifySuccess(
      "Kept synced",
      `Kept the synced copy for ${String(ok)} conflict${ok === 1 ? "" : "s"}.`,
    );
    this.render();
  }

  private bulkDismiss(ids: string[]): void {
    for (const id of ids) this.engine.inbox.resolve(id);
    notifySuccess(
      "Cleared",
      `Cleared ${String(ids.length)} item${ids.length === 1 ? "" : "s"} from the inbox.`,
    );
    this.render();
  }

  private async act(
    action: EntryAction,
    id: string,
    path: VaultPath,
    artifactPath: VaultPath | undefined,
  ): Promise<void> {
    try {
      switch (action) {
        case "open-current":
          this.openFile(path);
          return;
        case "open-backup":
          if (artifactPath !== undefined) this.openFile(artifactPath);
          return;
        case "keep-current":
          await this.engine.resolveContentConflict(id, "keep-current");
          break;
        case "keep-backup":
          await this.engine.resolveContentConflict(id, "keep-backup");
          break;
        case "confirm-delete":
          await this.engine.confirmPendingDelete(path);
          break;
        case "keep":
          await this.engine.dismissPendingDelete(path);
          break;
        case "acknowledge":
          this.engine.inbox.resolve(id);
          break;
        case "keep-mine":
          await this.engine.resolveConfigConflict(id, "keep-mine");
          break;
        case "keep-theirs":
          await this.engine.resolveConfigConflict(id, "keep-theirs");
          break;
        default: {
          // Exhaustiveness guard: a new core EntryAction fails the build in the exact file that
          // must handle it (this UI has no automated tests — the type system is its only net).
          const _exhaustive: never = action;
          throw new Error(`unhandled inbox action: ${String(_exhaustive)}`);
        }
      }
      this.render(); // observe() also fires, but re-render immediately for responsiveness.
    } catch (err) {
      if (err instanceof ArtifactNotLocalError) {
        notify({
          kind: "info",
          title: "On another device",
          detail: "That backup lives on another device. Open it there to choose.",
          durationMs: 0,
        });
        this.render();
        return;
      }
      notifyError("Could not resolve", err instanceof Error ? err.message : String(err));
    }
  }

  private openFile(path: VaultPath): void {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      void this.app.workspace
        .getLeaf(false)
        .openFile(f)
        .catch(() => {
          notifyError("Could not open", `Could not open ${path}.`);
        });
      this.close();
    } else {
      notifyInfo("Not here", `${path} is not on this device.`);
    }
  }
}
