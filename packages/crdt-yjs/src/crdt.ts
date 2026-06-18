import * as Y from "yjs";
import type {
  CrdtDoc,
  CrdtMap,
  CrdtProvider,
  DocId,
  EditOrigin,
  TextEdit,
  Unsubscribe,
} from "@zync/core";
import { YjsCrdtMap } from "./crdt-map.js";

/**
 * Name of the single shared `Y.Text` root that backs `CrdtDoc.getText()`.
 * Task 3's CodeMirror binding factory binds this same `Y.Text`.
 */
export const TEXT_NAME = "content";

const EDIT_ORIGINS: readonly EditOrigin[] = ["local-editor", "local-bridge", "remote"];

/**
 * Yjs-backed {@link CrdtDoc}. Exposes the underlying {@link Y.Doc} as `yDoc` so infrastructure
 * adapters in THIS package (e.g. the Hocuspocus transport, the CodeMirror binding) can bind the
 * same document. Core never sees `yDoc` — it works through the {@link CrdtDoc} port only.
 */
export class YjsCrdtDoc implements CrdtDoc {
  readonly id: DocId;
  readonly yDoc: Y.Doc;
  private readonly doc: Y.Doc;
  /**
   * Transaction-origin objects that represent a LOCAL EDITOR binding (e.g. a y-codemirror
   * `YSyncConfig`). An update whose Yjs origin is one of these is classified `"local-editor"` so the
   * engine treats live editor keystrokes as local UNACKED edits — NOT relay-acked remote content
   * (which would advance the acked base early and risk losing edits on an offline/crash window). The
   * binding registers its origin here via {@link markEditorOrigin} and clears it on destroy. A Set
   * because a doc may be bound to several editor panes at once. Identity-based on purpose: this keeps
   * `crdt.ts` free of any y-codemirror import (which would drag `@codemirror/*` into the headless daemon).
   */
  private readonly editorOrigins = new Set<object>();

  constructor(id: DocId, doc: Y.Doc) {
    this.id = id;
    this.doc = doc;
    this.yDoc = doc;
  }

  private text(): Y.Text {
    return this.doc.getText(TEXT_NAME);
  }

  /** Register a transaction-origin object as a local-editor binding (see {@link editorOrigins}). */
  markEditorOrigin(origin: object): void {
    this.editorOrigins.add(origin);
  }

  /** Unregister a previously {@link markEditorOrigin}'d origin (call on binding destroy). */
  unmarkEditorOrigin(origin: object): void {
    this.editorOrigins.delete(origin);
  }

  /** Number of registered editor-origin bindings (observability; used in tests). */
  get editorOriginCount(): number {
    return this.editorOrigins.size;
  }

  /**
   * Map a Yjs transaction origin to an {@link EditOrigin}: our own origin STRINGS pass through; a
   * registered editor-origin OBJECT reads `"local-editor"`; any other foreign origin (e.g. the
   * Hocuspocus provider applying a remote update) reads `"remote"`.
   */
  private classifyOrigin(origin: unknown): EditOrigin {
    if (EDIT_ORIGINS.includes(origin as EditOrigin)) return origin as EditOrigin;
    if (typeof origin === "object" && origin !== null && this.editorOrigins.has(origin)) {
      return "local-editor";
    }
    return "remote";
  }

  getText(): string {
    // `Y.Text.toJSON()` is the typed string accessor (returns `string`);
    // `toString()` trips no-base-to-string since Yjs lacks a custom signature.
    return this.text().toJSON();
  }

  applyEdits(edits: TextEdit[], origin: EditOrigin): void {
    this.doc.transact(() => {
      const ytext = this.text();
      // Apply splices in DESCENDING `at` order so earlier offsets stay valid as we mutate.
      const ordered = [...edits].sort((x, y) => y.at - x.at);
      for (const edit of ordered) {
        if (edit.delete > 0) ytext.delete(edit.at, edit.delete);
        if (edit.insert !== "") ytext.insert(edit.at, edit.insert);
      }
    }, origin);
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  encodeSnapshot(): Uint8Array {
    // Full state as a single update — the value `loadDoc` consumes.
    return Y.encodeStateAsUpdate(this.doc);
  }

  encodeUpdateSince(stateVector: Uint8Array): Uint8Array {
    // Minimal delta relative to the peer's known state vector.
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  applyUpdate(update: Uint8Array, origin: EditOrigin): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  onUpdate(cb: (update: Uint8Array, origin: EditOrigin) => void): Unsubscribe {
    const handler = (update: Uint8Array, origin: unknown): void => {
      cb(update, this.classifyOrigin(origin));
    };
    this.doc.on("update", handler);
    return () => {
      this.doc.off("update", handler);
    };
  }

  getMap<V>(name: string): CrdtMap<V> {
    return new YjsCrdtMap<V>(this.doc.getMap<V>(name));
  }

  destroy(): void {
    this.doc.destroy();
  }
}

/** `CrdtProvider` backed by Yjs. */
export class YjsCrdtProvider implements CrdtProvider {
  createDoc(id: DocId): CrdtDoc {
    return new YjsCrdtDoc(id, new Y.Doc());
  }

  loadDoc(id: DocId, snapshot: Uint8Array): CrdtDoc {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);
    return new YjsCrdtDoc(id, doc);
  }
}
