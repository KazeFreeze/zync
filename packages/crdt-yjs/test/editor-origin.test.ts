/**
 * Editor-origin classification (the formerly-deferred "Task 6").
 *
 * A live y-codemirror binding applies LOCAL editor edits in a Yjs transaction whose origin is its
 * `YSyncConfig` object. `YjsCrdtDoc` must classify updates from a REGISTERED editor-origin object as
 * `"local-editor"` (local unacked work) — NOT `"remote"` (relay-acked content). Misclassifying would
 * let the engine advance the acked base for unacked editor keystrokes → data loss on an offline/crash
 * window. This exercises the identity-based mechanism directly (no real CodeMirror needed); the real
 * yCollab origin behavior is the on-device gate.
 */
import { describe, it, expect } from "vitest";
import type { DocId, EditOrigin } from "@zync/core";
import { YjsCrdtProvider, YjsCrdtDoc, TEXT_NAME } from "../src/index.js";

const id = (s: string): DocId => s as DocId;

function newDoc(name: string): YjsCrdtDoc {
  return new YjsCrdtProvider().createDoc(id(name)) as YjsCrdtDoc;
}

/** Insert `text` at `at` inside a Yjs transaction stamped with the given (object) origin. */
function insertVia(doc: YjsCrdtDoc, at: number, text: string, origin: object): void {
  doc.yDoc.transact(() => {
    doc.yDoc.getText(TEXT_NAME).insert(at, text);
  }, origin);
}

/** Collect the classified origins of updates produced by `mutate`. */
function originsOf(doc: YjsCrdtDoc, mutate: () => void): EditOrigin[] {
  const seen: EditOrigin[] = [];
  const unsub = doc.onUpdate((_u, o) => seen.push(o));
  mutate();
  unsub();
  return seen;
}

describe("YjsCrdtDoc — editor-origin classification", () => {
  it("classifies a REGISTERED editor-origin object's edits as local-editor", () => {
    const doc = newDoc("e1");
    const editorOrigin = {}; // stand-in for a y-codemirror YSyncConfig
    doc.markEditorOrigin(editorOrigin);

    const origins = originsOf(doc, () => {
      insertVia(doc, 0, "hi", editorOrigin);
    });

    expect(origins).toEqual(["local-editor"]);
    doc.destroy();
  });

  it("classifies an UNREGISTERED foreign origin (e.g. the relay provider) as remote", () => {
    const doc = newDoc("e2");
    const providerOrigin = {}; // e.g. HocuspocusProvider applying a remote update

    const origins = originsOf(doc, () => {
      insertVia(doc, 0, "hi", providerOrigin);
    });

    expect(origins).toEqual(["remote"]);
    doc.destroy();
  });

  it("passes through our own EditOrigin strings unchanged", () => {
    const doc = newDoc("e3");

    const origins = originsOf(doc, () => {
      doc.applyEdits([{ at: 0, delete: 0, insert: "x" }], "local-editor");
      doc.applyEdits([{ at: 1, delete: 0, insert: "y" }], "local-bridge");
    });

    expect(origins).toEqual(["local-editor", "local-bridge"]);
    doc.destroy();
  });

  it("stops classifying as local-editor after the origin is unmarked", () => {
    const doc = newDoc("e4");
    const editorOrigin = {};
    doc.markEditorOrigin(editorOrigin);
    doc.unmarkEditorOrigin(editorOrigin);

    const origins = originsOf(doc, () => {
      insertVia(doc, 0, "z", editorOrigin);
    });

    expect(origins).toEqual(["remote"]);
    doc.destroy();
  });

  it("distinguishes two origins on the same doc (one editor pane, one remote)", () => {
    const doc = newDoc("e5");
    const editorOrigin = {};
    const remoteOrigin = {};
    doc.markEditorOrigin(editorOrigin); // only the editor one is registered

    const origins = originsOf(doc, () => {
      insertVia(doc, 0, "a", editorOrigin);
      insertVia(doc, 1, "b", remoteOrigin);
    });

    expect(origins).toEqual(["local-editor", "remote"]);
    doc.destroy();
  });
});
