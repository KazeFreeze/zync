/**
 * ObsidianEditorBinding — wires the engine's `active-bound` FileAuthority FSM to live CM6 editors, the
 * production counterpart of the harness `SimulatedEditor`. Design ratified by a GPT design-review.
 *
 * For each open markdown leaf with a mounted CM6 `EditorView`, it: (1) binds the file's authority
 * (`getAuthority(path).bindEditor(paneId)`) — which MUST precede (2) `ensureNoteAttached(path)` (the engine
 * only attaches `active-bound` authorities) — then (3) injects the `@zync/crdt-yjs` yCollab binding onto
 * that view via a per-view CM6 `Compartment`. Editor edits flow into the doc's `Y.Text` tagged `"local-editor"`
 * (the origin fix), so the engine treats them as local unacked work, not relay-acked remote content.
 *
 * Multi-pane: a registry keyed by `WorkspaceLeaf` identity binds EVERY open markdown source view (not just the
 * active one); the FSM stays `active-bound` while any pane holds the file. `reconcile()` runs on
 * active-leaf-change / file-open / layout-change.
 *
 * **Lifecycle:** `start()` registers the workspace handlers — the plugin MUST call it inside
 * `app.workspace.onLayoutReady(...)` so Obsidian's startup leaf inventory doesn't bind before the engine is
 * ready. `stop()` (plugin onunload) unbinds every pane before the engine stops.
 *
 * `obsidian` is types-only at runtime, so this imports it as TYPES ONLY and duck-types the markdown view.
 */

import type { App, EventRef, WorkspaceLeaf } from "obsidian";
import { Compartment, StateEffect, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CrdtDoc, VaultPath } from "@zync/core";
import { buildEditorBinding } from "@zync/crdt-yjs/binding";

/** The slice of `FileAuthority` the binding drives. */
interface EditorAuthority {
  bindEditor(paneId: string): void;
  unbindEditor(paneId: string): void;
}

/** The slice of `SyncEngine` the binding needs (structurally satisfied by `SyncEngine`). */
export interface EditorBindingEngine {
  getAuthority(path: VaultPath): EditorAuthority;
  ensureNoteAttached(path: VaultPath): Promise<CrdtDoc | undefined>;
}

/** Injectable binding factory (defaults to `@zync/crdt-yjs`'s `buildEditorBinding`) — swapped in tests. */
export type BindingFactory = (doc: CrdtDoc) => { extension: Extension; destroy: () => void };

interface Entry {
  paneId: string;
  path: VaultPath;
  view: EditorView;
  compartment: Compartment;
  binding: { extension: Extension; destroy: () => void };
}

/** Reach the CM6 `EditorView` behind an Obsidian markdown leaf, or null (preview mode / not mounted). */
function editorViewOf(leaf: WorkspaceLeaf): EditorView | null {
  const view = leaf.view as
    | { getViewType?: () => string; editor?: { cm?: EditorView } }
    | undefined;
  if (view?.getViewType?.() !== "markdown") return null;
  return view.editor?.cm ?? null;
}

function pathOf(leaf: WorkspaceLeaf): VaultPath | undefined {
  const view = leaf.view as { file?: { path?: string } } | undefined;
  const p = view?.file?.path;
  return p === undefined ? undefined : (p as VaultPath);
}

/** True if the leaf hosts a markdown view — whether or not its CM editor is mounted yet. */
function isMarkdownLeaf(leaf: WorkspaceLeaf): boolean {
  return (leaf.view as { getViewType?: () => string } | undefined)?.getViewType?.() === "markdown";
}

/** Bounded retry for the CM-mount timing gap (a just-opened note may not have its EditorView yet). */
const MAX_MOUNT_RETRIES = 20;
const MOUNT_RETRY_MS = 100;

export class ObsidianEditorBinding {
  private readonly app: App;
  private readonly engine: EditorBindingEngine;
  private readonly buildBinding: BindingFactory;

  private readonly entries = new Map<WorkspaceLeaf, Entry>();
  private readonly paneIds = new WeakMap<WorkspaceLeaf, string>();
  /** Leaves with an in-flight `bindLeaf` — prevents a concurrent reconcile from double-binding. */
  private readonly inFlight = new Set<WorkspaceLeaf>();
  private eventRefs: EventRef[] = [];
  private paneCounter = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryBudget = MAX_MOUNT_RETRIES;

  constructor(
    app: App,
    engine: EditorBindingEngine,
    buildBinding: BindingFactory = buildEditorBinding,
  ) {
    this.app = app;
    this.engine = engine;
    this.buildBinding = buildBinding;
  }

  /** Register workspace handlers + bind currently-open leaves. Call inside `workspace.onLayoutReady`. */
  start(): void {
    const ws = this.app.workspace;
    this.eventRefs = [
      ws.on("active-leaf-change", () => {
        void this.reconcile();
      }),
      ws.on("file-open", () => {
        void this.reconcile();
      }),
      ws.on("layout-change", () => {
        void this.reconcile();
      }),
    ];
    void this.reconcile();
  }

  /** Detach handlers + unbind every pane. Call from the plugin's `onunload` BEFORE `engine.stop()`. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const ref of this.eventRefs) this.app.workspace.offref(ref);
    this.eventRefs = [];
    for (const leaf of [...this.entries.keys()]) this.unbindLeaf(leaf);
  }

  /** Bind newly-open markdown source views, unbind stale/closed ones. Idempotent + re-entrant-safe. */
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    const seen = new Set<WorkspaceLeaf>();
    const open: WorkspaceLeaf[] = [];
    const pendingMount: WorkspaceLeaf[] = []; // markdown notes open whose CM view isn't mounted yet
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!isMarkdownLeaf(leaf) || pathOf(leaf) === undefined) return;
      if (editorViewOf(leaf) !== null) open.push(leaf);
      else if (!this.entries.has(leaf)) pendingMount.push(leaf);
    });

    for (const leaf of open) {
      seen.add(leaf);
      const path = pathOf(leaf);
      if (path === undefined) continue;
      const existing = this.entries.get(leaf);
      if (existing?.path === path) continue; // already bound to the same file
      if (existing) this.unbindLeaf(leaf); // leaf now shows a different file → rebind
      await this.bindLeaf(leaf, path);
    }

    // Unbind leaves we no longer see (closed, moved to preview, or detached).
    for (const leaf of [...this.entries.keys()]) {
      if (!seen.has(leaf)) this.unbindLeaf(leaf);
    }

    // CM-mount timing gap (the 0a finding): a just-opened note's EditorView may not exist when the
    // workspace event fired. Requeue a BOUNDED retry so it binds without waiting for the next user
    // action; reset the budget once nothing is pending (so a steady-state preview leaf can't spin).
    if (pendingMount.length > 0) {
      if (this.retryBudget > 0) {
        this.retryBudget -= 1;
        this.scheduleRetry();
      }
    } else {
      this.retryBudget = MAX_MOUNT_RETRIES;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile();
    }, MOUNT_RETRY_MS);
  }

  private async bindLeaf(leaf: WorkspaceLeaf, path: VaultPath): Promise<void> {
    if (this.inFlight.has(leaf) || this.entries.has(leaf)) return;
    const cm = editorViewOf(leaf);
    // No mounted CM view: reading/preview mode, OR a just-opened leaf whose EditorView hasn't mounted
    // yet. A later workspace event (layout-change / active-leaf-change) re-reconciles. NOTE: the 0a spike
    // needed an explicit mount-retry; if notes don't bind on FIRST open in real Obsidian, add a bounded
    // retry requeue here (verify-in-Obsidian item).
    if (cm === null) return;

    // Set the guard BEFORE the synchronous bindEditor (not just before the await) so the in-flight
    // bracket covers the whole critical section — a concurrent reconcile then can't double-bind.
    this.inFlight.add(leaf);
    const paneId = this.paneIdFor(leaf);
    const authority = this.engine.getAuthority(path);
    authority.bindEditor(paneId); // MUST precede ensureNoteAttached (only active-bound authorities attach)
    try {
      const doc = await this.engine.ensureNoteAttached(path);
      // The leaf may have closed / changed file / been stopped during the await — bail + release the bind.
      if (this.stopped || doc === undefined || editorViewOf(leaf) !== cm || pathOf(leaf) !== path) {
        authority.unbindEditor(paneId);
        return;
      }
      const binding = this.buildBinding(doc);
      const compartment = new Compartment();
      // CRDT-AUTHORITATIVE ATTACH. Obsidian populates the editor from DISK before we bind, so on a
      // cold restart its text can differ from the reconciled Y.Text. y-codemirror's ySync assumes the
      // editor was INITIALIZED from the Y.Text; when it wasn't, ySync replays Y.Text deltas onto the
      // stale editor text and that divergence gets double-applied back into the doc (the cold-restart
      // duplication bug seen in real Obsidian). So replace the editor's content with the doc's current
      // text IN THE SAME transaction that installs ySync — atomically establishing editor === Y.Text
      // before ySync tracks. The doc is authoritative here: `ensureNoteAttached` reconciled any disk
      // edit into it above. Guarded so a normal open (editor already matches) makes no spurious change.
      const crdtText = doc.getText();
      const effects = StateEffect.appendConfig.of(compartment.of(binding.extension));
      cm.dispatch(
        cm.state.doc.toString() === crdtText
          ? { effects }
          : { changes: { from: 0, to: cm.state.doc.length, insert: crdtText }, effects },
      );
      this.entries.set(leaf, { paneId, path, view: cm, compartment, binding });
    } finally {
      this.inFlight.delete(leaf);
    }
  }

  private unbindLeaf(leaf: WorkspaceLeaf): void {
    const e = this.entries.get(leaf);
    if (e === undefined) return;
    this.entries.delete(leaf);
    try {
      e.view.dispatch({ effects: e.compartment.reconfigure([]) });
    } catch {
      // The view may already be torn down — removing the binding is then moot.
    }
    try {
      e.binding.destroy();
    } finally {
      // Always release the FSM bind, even if destroy throws — else the authority leaks `active-bound`.
      this.engine.getAuthority(e.path).unbindEditor(e.paneId);
    }
  }

  private paneIdFor(leaf: WorkspaceLeaf): string {
    let id = this.paneIds.get(leaf);
    if (id === undefined) {
      id = `pane-${String(++this.paneCounter)}`;
      this.paneIds.set(leaf, id);
    }
    return id;
  }
}
