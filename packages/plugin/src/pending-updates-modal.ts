import { Modal, setIcon, type App } from "obsidian";
import type { SyncEngine } from "@zync/core";

/**
 * Batched pending-plugin-update modal (Task 8 / D9).
 *
 * When new code arrives for an ALREADY-RUNNING plugin Zync stages the bytes (community-plugins.json
 * projection + materialized files) but does NOT hot-reload. This modal lets the user review the
 * staged set and apply each update (disable→enable via `onApply`) or reload Obsidian in one shot.
 *
 * Mirrors `ConflictInboxModal`'s structure: constructor, onOpen/onClose, render, renderRow, button.
 */
export class PendingUpdatesModal extends Modal {
  private readonly engine: SyncEngine;
  private readonly onApply: (id: string) => void;
  private unsub: (() => void) | null = null;

  constructor(app: App, engine: SyncEngine, onApply: (id: string) => void) {
    super(app);
    this.engine = engine;
    this.onApply = onApply;
  }

  override onOpen(): void {
    this.titleEl.setText("Pending plugin updates");
    this.modalEl.addClass("zync-inbox-modal");
    this.unsub = this.engine.onPendingUpdates(() => this.render());
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

    const ids = this.engine.pendingPluginUpdates();
    if (ids.length === 0) {
      const empty = contentEl.createDiv({ cls: "zync-empty" });
      setIcon(empty.createDiv({ cls: "zync-empty-icon" }), "check-circle");
      empty.createEl("p", { cls: "zync-empty-title", text: "No pending updates" });
      empty.createEl("p", {
        cls: "zync-empty-sub",
        text: "All plugin code is up to date on this device.",
      });
      return;
    }

    this.renderTopBar(contentEl, ids);

    const list = contentEl.createDiv({ cls: "zync-list" });
    for (const id of ids) this.renderRow(list, id);
  }

  private renderTopBar(parent: HTMLElement, ids: string[]): void {
    const bar = parent.createDiv({ cls: "zync-topbar" });
    const n = ids.length;
    bar.createSpan({
      cls: "zync-count",
      text: `${String(n)} plugin update${n === 1 ? "" : "s"} ready`,
    });

    const actions = bar.createDiv({ cls: "zync-topbar-actions" });

    // "Apply all" — live-reloads every pending plugin.
    const applyAll = actions.createEl("button", {
      cls: "zync-btn zync-btn-sm mod-cta",
      text: `Apply all (${String(n)})`,
    });
    applyAll.onclick = () => {
      for (const id of [...ids]) this.onApply(id);
    };

    // "Reload Obsidian" — the guaranteed floor: all staged bytes are already on disk,
    // so a full app restart picks them up even if the live-reload path is unavailable.
    const reload = actions.createEl("button", {
      cls: "zync-btn zync-btn-sm",
      text: "Reload Obsidian",
    });
    reload.onclick = () => {
      (
        this.app as unknown as {
          commands: { executeCommandById(id: string): void };
        }
      ).commands.executeCommandById("app:reload");
    };
  }

  private renderRow(parent: HTMLElement, id: string): void {
    const row = parent.createDiv({ cls: "zync-row" });

    const main = row.createDiv({ cls: "zync-row-main" });
    const label = main.createDiv({ cls: "zync-row-label" });
    const chip = label.createSpan({ cls: "zync-chip", text: "update" });
    chip.dataset.kind = "plugin-update";
    label.createSpan({ cls: "zync-row-name", text: id });

    const act = main.createDiv({ cls: "zync-row-act" });
    this.button(act, "Apply", id);

    const sub = row.createDiv({ cls: "zync-row-sub" });
    sub.createSpan({
      text: "New code/settings materialized. Apply to reload, or restart Obsidian.",
    });
  }

  private button(parent: HTMLElement, text: string, id: string): void {
    const b = parent.createEl("button", { text, cls: "zync-btn zync-btn-sm mod-cta" });
    b.onclick = () => this.onApply(id);
  }
}
