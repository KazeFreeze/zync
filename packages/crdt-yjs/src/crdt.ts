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
 * Map a Yjs transaction origin back to an {@link EditOrigin}. When a doc edit/update
 * carries one of our own origin strings we pass it through; any foreign origin
 * (e.g. a CodeMirror binding's own origin object) looks `"remote"` to the engine.
 *
 * NOTE: Task 6 revisits binding-origin tagging so editor-bound transactions can be
 * distinguished from true remote updates; until then they intentionally read as remote.
 */
function toEditOrigin(origin: unknown): EditOrigin {
  return EDIT_ORIGINS.includes(origin as EditOrigin) ? (origin as EditOrigin) : "remote";
}

/**
 * Yjs-backed {@link CrdtDoc}. Exposes the underlying {@link Y.Doc} as `yDoc` so infrastructure
 * adapters in THIS package (e.g. the Hocuspocus transport, the CodeMirror binding) can bind the
 * same document. Core never sees `yDoc` — it works through the {@link CrdtDoc} port only.
 */
export class YjsCrdtDoc implements CrdtDoc {
  readonly id: DocId;
  readonly yDoc: Y.Doc;
  private readonly doc: Y.Doc;

  constructor(id: DocId, doc: Y.Doc) {
    this.id = id;
    this.doc = doc;
    this.yDoc = doc;
  }

  private text(): Y.Text {
    return this.doc.getText(TEXT_NAME);
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
      cb(update, toEditOrigin(origin));
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
