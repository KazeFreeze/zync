import { Modal, Notice, TFile, setIcon, type App } from "obsidian";
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
    if (entries.length === 0) {
      const empty = contentEl.createDiv({ cls: "zync-empty" });
      setIcon(empty.createDiv({ cls: "zync-empty-icon" }), "check-circle");
      empty.createEl("p", { cls: "zync-empty-title", text: "You're all caught up" });
      empty.createEl("p", {
        cls: "zync-empty-sub",
        text: "Nothing to review. Every note is in sync.",
      });
      return;
    }

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
      this.link(sub, f.openCurrent, "open-current", entry);
      sub.createSpan({ cls: "zync-dot", text: "·" });
      this.link(sub, f.openBackup, "open-backup", entry);
      sub.createSpan({ cls: "zync-dot", text: "·" });
      this.link(sub, "Leave for now", "acknowledge", entry);
      return;
    }

    // Non-chooser kinds: primary actions inline, Open/Acknowledge as links in the sub-line.
    sub.createSpan({ text: `${view.title} ` });
    for (const spec of view.actions) {
      if (spec.action === "open-current" || spec.action === "open-backup") {
        this.link(sub, spec.label, spec.action, entry);
        sub.createSpan({ cls: "zync-dot", text: "·" });
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
    new Notice(`Zync: kept the synced copy for ${String(ok)} conflict${ok === 1 ? "" : "s"}.`);
    this.render();
  }

  private bulkDismiss(ids: string[]): void {
    for (const id of ids) this.engine.inbox.resolve(id);
    new Notice(
      `Zync: cleared ${String(ids.length)} item${ids.length === 1 ? "" : "s"} from the inbox.`,
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
        new Notice("Zync: that backup lives on another device. Open it there to choose.");
        this.render();
        return;
      }
      new Notice(`Zync: could not resolve. ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private openFile(path: VaultPath): void {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      void this.app.workspace
        .getLeaf(false)
        .openFile(f)
        .catch(() => {
          new Notice(`Zync: could not open ${path}.`);
        });
      this.close();
    } else {
      new Notice(`Zync: ${path} is not on this device.`);
    }
  }
}
