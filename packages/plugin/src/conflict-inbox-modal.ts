import { Modal, TFile, setIcon, setTooltip, type App } from "obsidian";
import { notify, notifySuccess, notifyInfo, notifyError } from "./notify.js";
import { stuckCopy, TAG_NEVER_ARRIVED } from "./stuck-copy.js";
import {
  SyncEngine,
  describeInboxEntry,
  provenanceLine,
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
      void this.bulkDismiss(items.map((i) => i.entry.id));
    };
  }

  /**
   * The STUCK section: a REPORT, not a chooser. A conflict row promises a decision with two safe
   * buttons; these items may have NO available action, so they get no primary button (a fake CTA
   * teaches users that buttons are decorative).
   *
   * The heading is the FILE NAME for a single item (matching every other row in this modal) and an
   * aggregate count only when there are several, which is also what keeps it consistent with the
   * status bar's doc count. Copy branches per class via {@link stuckCopy}: generic wording is
   * factually wrong for the never-arrived case and would send the user to reconnect for nothing.
   */
  private renderStuckSection(
    parent: HTMLElement,
    stuck: { docId: string; path: string | null }[],
  ): void {
    const items = stuck.map((s) => ({
      ...s,
      onDisk: s.path !== null && this.app.vault.getAbstractFileByPath(s.path) instanceof TFile,
    }));
    const copy = stuckCopy(items.map((i) => ({ path: i.path, onDisk: i.onDisk })));

    const list = parent.createDiv({ cls: "zync-list" });
    const row = list.createDiv({ cls: "zync-row zync-stuck-row" });

    const main = row.createDiv({ cls: "zync-row-main" });
    const label = main.createDiv({ cls: "zync-row-label" });
    const chip = label.createSpan({ cls: "zync-chip", text: "stuck" });
    chip.dataset.kind = "stuck";

    const [only] = items;
    if (items.length === 1 && only !== undefined) {
      // Single item: the name IS the heading. No separate list line, which would be a third
      // repetition of the same fact (chip + heading + tag) and is what made the row read as noise.
      this.stuckName(label, only);
      if (only.onDisk && only.path !== null) this.stuckOpenLink(label, only.path);
    } else {
      // "N items", not "N items stuck": the chip already says stuck. Matches the topbar's noun.
      label.createSpan({ cls: "zync-row-name", text: `${String(items.length)} items` });
    }

    row.createDiv({ cls: "zync-row-sub", text: copy.sub });

    // Multi only. SIBLING of the sub-line, never nested: `.zync-row-sub` uses a RELATIVE font-size,
    // so nesting it compounds the shrink and the text turns unreadable.
    if (items.length > 1) {
      const listEl = row.createDiv({ cls: "zync-stuck-items" });
      const SHOWN = 10;
      for (const s of items.slice(0, SHOWN)) {
        const line = listEl.createDiv({ cls: "zync-stuck-item" });
        this.stuckName(line, s);
        if (s.onDisk && s.path !== null) this.stuckOpenLink(line, s.path);
        else if (s.path !== null) {
          // A classifier, not a sentence: the fix line quotes this tag verbatim to scope itself.
          line.createSpan({ cls: "zync-stuck-why", text: ` ${TAG_NEVER_ARRIVED}` });
        }
      }
      if (items.length > SHOWN) {
        listEl.createDiv({
          cls: "zync-stuck-item zync-stuck-why",
          text: `+${String(items.length - SHOWN)} more`,
        });
      }
    }

    if (copy.fix !== null) row.createDiv({ cls: "zync-stuck-fix", text: copy.fix });
  }

  /**
   * The stuck item's name. Shows the FOLDER PREFIX as well as the basename: the manual fix depends
   * on the exact path, and a hover title is useless on mobile (which has no hover at all).
   */
  private stuckName(parent: HTMLElement, s: { docId: string; path: string | null }): void {
    if (s.path === null) {
      // No index entry: a leftover with no note. Never render a blank name.
      parent.createSpan({
        cls: "zync-stuck-name",
        text: `Untracked entry (${s.docId.slice(0, 8)})`,
      });
      return;
    }
    const slash = s.path.lastIndexOf("/");
    if (slash !== -1) {
      parent.createSpan({ cls: "zync-stuck-dir", text: s.path.slice(0, slash + 1) });
    }
    parent.createSpan({ cls: "zync-stuck-name", text: baseName(s.path) });
  }

  /** "Open" is the row's only interactive element, and only when the file is really on disk. */
  private stuckOpenLink(parent: HTMLElement, path: string): void {
    parent.createSpan({ text: " " });
    const a = parent.createEl("a", { cls: "zync-inline-link", text: "Open", href: "#" });
    a.onclick = (e): void => {
      e.preventDefault();
      void this.app.workspace.openLinkText(path, "", false);
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

    // WHERE it came from, before WHAT to do about it. The inbox is shared across devices, so
    // "which device detected this, and could it see the others at the time" is often the whole
    // answer — especially for a conflict formed while that device was offline.
    const prov = provenanceLine(entry);
    if (prov !== null) row.createDiv({ cls: "zync-row-prov", text: prov });

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

  /**
   * Clear many entries without freezing Obsidian. Two problems had to be fixed together: each
   * resolve was its OWN CRDT transaction (so N entries meant N transactions AND N observer
   * cascades), and the whole loop ran synchronously on the main thread (so the UI could not paint
   * until it finished). Now each CHUNK is one batched transaction, and we yield between chunks so
   * the app stays responsive on an inbox with hundreds of entries.
   */
  private async bulkDismiss(ids: string[]): Promise<void> {
    const CHUNK = 50;
    for (let i = 0; i < ids.length; i += CHUNK) {
      this.engine.inbox.resolveMany(ids.slice(i, i + CHUNK));
      // Yield to the event loop so Obsidian can paint between chunks (a macrotask, not a
      // microtask: a microtask would run before the browser gets a chance to render).
      if (i + CHUNK < ids.length) await new Promise((r) => setTimeout(r, 0));
    }
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
