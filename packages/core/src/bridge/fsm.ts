export type AuthorityState = "inactive" | "active-bound";
export type WriteAction = "ingest" | "ignore" | "detach-merge-rebind";

/**
 * Single-authority lifecycle (design §8.1), reduced to two states by design (Fable NEW-7 #3):
 * the six spec states collapse because `pending-write` is the EchoLedger's job and
 * `opening`/`closing` are plugin-lifecycle, not core logic. A note open in multiple panes
 * forms a binding SET; it is `active-bound` while any pane holds it.
 */
export class FileAuthority {
  readonly #bindings = new Set<string>();

  constructor(public readonly path: string) {}

  get state(): AuthorityState {
    return this.#bindings.size > 0 ? "active-bound" : "inactive";
  }

  bindEditor(paneId: string): void {
    this.#bindings.add(paneId);
  }

  unbindEditor(paneId: string): void {
    this.#bindings.delete(paneId);
  }

  /** A vault `modify` not attributable to our own programmatic write. */
  onExternalWrite(): WriteAction {
    return this.state === "active-bound" ? "detach-merge-rebind" : "ingest";
  }

  /** Obsidian saving the editor we're bound to — must not be re-ingested. */
  onOwnEditorSave(): WriteAction {
    return this.state === "active-bound" ? "ignore" : "ingest";
  }
}
