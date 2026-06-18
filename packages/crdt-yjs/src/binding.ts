import { type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  ySync,
  ySyncFacet,
  YSyncConfig,
  yRemoteSelections,
  yRemoteSelectionsTheme,
} from "y-codemirror.next";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { CrdtDoc } from "@zync/core";
import { YjsCrdtDoc, TEXT_NAME } from "./crdt.js";

/**
 * Build the CM6 editor extension binding the active editor to the doc's `Y.Text`, plus a local
 * Y.UndoManager. Returns `{ extension, destroy }` — one binding + one destroy lifecycle per EditorView.
 *
 * ORIGIN TAGGING (the formerly-deferred "Task 6"): y-codemirror applies LOCAL editor edits in a Yjs
 * transaction whose origin IS the `YSyncConfig`. We construct the `YSyncConfig` OURSELVES (instead of
 * via `yCollab`, which hides its own) and register it on the doc via {@link YjsCrdtDoc.markEditorOrigin},
 * so the engine classifies live editor keystrokes as `"local-editor"` — local UNACKED edits — rather
 * than relay-acked `"remote"` content (which would advance the acked base early and risk losing edits
 * on an offline/crash window). `destroy()` unregisters it.
 *
 * THE UNDO FIX (Phase-0a finding): y-codemirror's ySync writes remote edits into the editor WITHOUT
 * `addToHistory:false`, so Obsidian's native CM6 history captures them and a plain Ctrl-Z reverts remote
 * text. We route undo/redo to the Yjs UndoManager (local-only) at HIGHEST precedence (keyboard) and via
 * the `beforeinput` history events (what yCollab's own undo plugin covers). The UndoManager only captures
 * transactions whose origin it TRACKS — so we `addTrackedOrigin(conf)` (yCollab's undo plugin does the
 * equivalent); without it the stack stays empty and undo is a silent no-op.
 * RESIDUALS (M1 gaps, validated on-device): the mobile toolbar undo button is an Obsidian command (not a
 * keymap/beforeinput); and unlike yCollab's undo ViewPlugin we do NOT restore the editor selection on
 * undo/redo (text reverts correctly, but the cursor isn't moved back to the edit site).
 *
 * AWARENESS is optional: M1 uses LOCAL-ONLY awareness (no cross-device cursor presence) built against the
 * SAME `Y.Doc` that owns the bound `Y.Text`. A caller-supplied awareness is left for the caller to dispose.
 */
export function buildEditorBinding(
  doc: CrdtDoc,
  awareness?: Awareness,
): { extension: Extension; destroy: () => void } {
  if (!(doc instanceof YjsCrdtDoc)) {
    throw new Error("buildEditorBinding requires a Yjs-backed CrdtDoc");
  }
  const ytext: Y.Text = doc.yDoc.getText(TEXT_NAME);

  const ownAwareness = awareness === undefined;
  const aw = awareness ?? new Awareness(doc.yDoc);

  // Own the YSyncConfig so we hold the exact transaction-origin y-codemirror stamps on local edits.
  const conf = new YSyncConfig(ytext, aw);
  doc.markEditorOrigin(conf);

  const undoManager = new Y.UndoManager(ytext);
  // Track the binding's own origin so local editor edits (origin = conf) land on the undo stack —
  // a Y.UndoManager only captures tracked origins (default {null}), and yCollab's undo plugin does
  // this same addTrackedOrigin. Without it Ctrl-Z / beforeinput-undo would no-op (empty stack).
  undoManager.addTrackedOrigin(conf);
  const undoRedoKeymap = Prec.highest(
    keymap.of([
      { key: "Mod-z", run: () => (undoManager.undo(), true) },
      { key: "Mod-y", run: () => (undoManager.redo(), true) },
      { key: "Mod-Shift-z", run: () => (undoManager.redo(), true) },
    ]),
  );
  const undoInput = EditorView.domEventHandlers({
    beforeinput: (e: InputEvent) => {
      if (e.inputType === "historyUndo") {
        undoManager.undo();
        return true;
      }
      if (e.inputType === "historyRedo") {
        undoManager.redo();
        return true;
      }
      return false;
    },
  });

  // Replicates yCollab's composition from the EXPORTED pieces (its undo internals aren't exported) so
  // we control the YSyncConfig: ySync + remote-selection rendering + our undo handling.
  const extension: Extension = [
    ySyncFacet.of(conf),
    ySync,
    yRemoteSelectionsTheme,
    yRemoteSelections,
    undoRedoKeymap,
    undoInput,
  ];

  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    doc.unmarkEditorOrigin(conf);
    undoManager.destroy();
    if (ownAwareness) aw.destroy();
  };

  return { extension, destroy };
}
