import { Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

/**
 * Build the CM6 editor extension binding `ytext` to the active editor, plus a
 * Y.UndoManager. The UndoManager (per y-codemirror) tracks only the LOCAL sync
 * origin; remote edits arrive with origin = the Hocuspocus provider, so they are
 * never on its undo stack.
 *
 * THE UNDO FIX (Phase-0a finding): y-codemirror's ySync writes remote edits into
 * the editor WITHOUT `addToHistory:false` (y-sync.js:123), so Obsidian's native,
 * non-removable CM6 history captures them — and Obsidian's Ctrl-Z hits that native
 * history, reverting remote text. We override Ctrl-Z / Ctrl-Y / Ctrl-Shift-Z at
 * HIGHEST precedence to route undo/redo to the Yjs UndoManager (local-only),
 * beating Obsidian's native undo.
 */
export function buildBinding(
  ytext: Y.Text,
  awareness: Awareness,
): {
  extension: Extension;
  undoManager: Y.UndoManager;
} {
  const undoManager = new Y.UndoManager(ytext);
  const collab = yCollab(ytext, awareness, { undoManager });
  const undoRedoKeymap = Prec.highest(
    keymap.of([
      { key: "Mod-z", run: () => (undoManager.undo(), true) },
      { key: "Mod-y", run: () => (undoManager.redo(), true) },
      { key: "Mod-Shift-z", run: () => (undoManager.redo(), true) },
    ]),
  );
  return { extension: [undoRedoKeymap, collab], undoManager };
}
