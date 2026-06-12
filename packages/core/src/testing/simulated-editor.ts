import type { CrdtDoc } from "../ports.js";
import type { FileAuthority } from "../bridge/fsm.js";

/**
 * Headless stand-in for the Phase-0a CM6/yCollab editor binding.
 *
 * Simulates a single editor PANE bound to a CRDT doc: `open()`/`close()` drive the
 * {@link FileAuthority} binding set (so the file becomes `active-bound`), and `type`/
 * `replaceRange` push edits into the Y.Text carrying origin `"local-editor"` — the
 * editor's OWN changes, which the ingest pipeline must never re-ingest as external.
 *
 * Because the real binding makes the editor FOLLOW the Y.Text, `text()` reads straight
 * from the doc: applying an ingest merge to the attached doc is exactly what makes the
 * live editor converge ("detach → 3-way merge → rebind" reduces to ingesting into the
 * attached doc — rebind is implicit).
 *
 * This is purely a test double. The real Gboard-IME / on-device editing behavior is the
 * forever-manual gate that already PASSED in Phase 0a and cannot be exercised headlessly.
 */
export class SimulatedEditor {
  readonly #doc: CrdtDoc;
  readonly #authority: FileAuthority;
  readonly #paneId: string;

  constructor(doc: CrdtDoc, authority: FileAuthority, paneId: string) {
    this.#doc = doc;
    this.#authority = authority;
    this.#paneId = paneId;
  }

  get paneId(): string {
    return this.#paneId;
  }

  /** Bind this pane to the file's authority (the file becomes `active-bound`). */
  open(): void {
    this.#authority.bindEditor(this.#paneId);
  }

  /** Unbind this pane. The file stays `active-bound` while any other pane holds it. */
  close(): void {
    this.#authority.unbindEditor(this.#paneId);
  }

  /** Type `text` at offset `at` — an editor-origin insert. */
  type(at: number, text: string): void {
    this.#doc.applyEdits([{ at, delete: 0, insert: text }], "local-editor");
  }

  /** Replace `del` chars at `at` with `ins` — an editor-origin splice. */
  replaceRange(at: number, del: number, ins: string): void {
    this.#doc.applyEdits([{ at, delete: del, insert: ins }], "local-editor");
  }

  /** The live document text the editor is showing (it FOLLOWS the bound Y.Text). */
  text(): string {
    return this.#doc.getText();
  }
}
