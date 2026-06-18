import { describe, it, expect, afterEach, vi } from "vitest";
import type { App, WorkspaceLeaf } from "obsidian";
import type { CrdtDoc, VaultPath } from "@zync/core";
import { ObsidianEditorBinding, type EditorBindingEngine } from "./editor-binding.js";

// Stop every binding created via setup() after each test so a pending cm-mount retry timer
// (scheduled when a markdown leaf has no mounted CM, e.g. the preview-leaf test) can't dangle.
const createdBindings: ObsidianEditorBinding[] = [];
afterEach(() => {
  for (const b of createdBindings.splice(0)) b.stop();
});

// ---------------------------------------------------------------------------
// Mocks — Obsidian workspace/leaf/view + the engine slice the binding drives.
// ---------------------------------------------------------------------------

interface DispatchSpec {
  effects?: unknown;
  changes?: { from: number; to: number; insert: string };
}
interface MockCm {
  dispatched: DispatchSpec[];
  docText: string;
}

function makeCm(docText = ""): MockCm {
  return { dispatched: [], docText };
}

/** A markdown leaf in source mode (cm present) or preview (cm null). */
function makeLeaf(path: string | null, cm: MockCm | null): WorkspaceLeaf {
  return {
    view: {
      getViewType: () => "markdown",
      editor: {
        cm:
          cm === null
            ? undefined
            : {
                // Model the CM6 doc so the CRDT-authoritative-attach replace can be asserted.
                state: { doc: { toString: () => cm.docText, length: cm.docText.length } },
                dispatch: (spec: DispatchSpec) => {
                  cm.dispatched.push(spec);
                  if (spec.changes !== undefined) cm.docText = spec.changes.insert;
                },
              },
      },
      file: path === null ? null : { path },
    },
  } as unknown as WorkspaceLeaf;
}

/** A non-markdown leaf (e.g. a graph view) — must be ignored. */
function makeNonMarkdownLeaf(): WorkspaceLeaf {
  return { view: { getViewType: () => "graph" } } as unknown as WorkspaceLeaf;
}

interface MockWorkspace {
  app: App;
  setLeaves(leaves: WorkspaceLeaf[]): void;
  offrefCount(): number;
}

function makeApp(): MockWorkspace {
  let leaves: WorkspaceLeaf[] = [];
  let offrefs = 0;
  const app = {
    workspace: {
      on: (name: string) => ({ name }),
      offref: () => {
        offrefs += 1;
      },
      iterateAllLeaves: (cb: (leaf: WorkspaceLeaf) => void) => {
        for (const l of leaves) cb(l);
      },
    },
  } as unknown as App;
  return {
    app,
    setLeaves: (next) => {
      leaves = next;
    },
    offrefCount: () => offrefs,
  };
}

interface EngineCalls {
  log: string[];
  attached: Set<string>; // paths to return a doc for (else undefined)
  docText: string; // the CRDT text the attached doc reports via getText()
}

function makeEngine(calls: EngineCalls): EditorBindingEngine {
  return {
    getAuthority: (path: VaultPath) => ({
      bindEditor: (paneId: string) => calls.log.push(`bind ${path} ${paneId}`),
      unbindEditor: (paneId: string) => calls.log.push(`unbind ${path} ${paneId}`),
    }),
    ensureNoteAttached: (path: VaultPath) => {
      calls.log.push(`attach ${path}`);
      return Promise.resolve(
        calls.attached.has(path)
          ? ({ getText: () => calls.docText } as unknown as CrdtDoc)
          : undefined,
      );
    },
  };
}

/** Binding factory that records each destroy; returns a trivial (empty) extension. */
function makeFactory(): {
  factory: (doc: CrdtDoc) => { extension: never[]; destroy: () => void };
  destroys: () => number;
} {
  let destroys = 0;
  return {
    factory: () => ({
      extension: [],
      destroy: () => {
        destroys += 1;
      },
    }),
    destroys: () => destroys,
  };
}

function setup(attachedPaths: string[] = []): {
  binding: ObsidianEditorBinding;
  ws: MockWorkspace;
  calls: EngineCalls;
  factoryDestroys: () => number;
} {
  const ws = makeApp();
  const calls: EngineCalls = { log: [], attached: new Set(attachedPaths), docText: "" };
  const f = makeFactory();
  const binding = new ObsidianEditorBinding(ws.app, makeEngine(calls), f.factory);
  createdBindings.push(binding);
  return { binding, ws, calls, factoryDestroys: f.destroys };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ObsidianEditorBinding — reconcile lifecycle", () => {
  it("binds an open markdown source leaf (authority bound BEFORE attach, then CM extension dispatched)", async () => {
    const { binding, ws, calls } = setup(["notes/a.md"]);
    const cm = makeCm();
    ws.setLeaves([makeLeaf("notes/a.md", cm)]);

    await binding.reconcile();

    // bindEditor must precede ensureNoteAttached (the engine only attaches active-bound authorities).
    expect(calls.log).toEqual(["bind notes/a.md pane-1", "attach notes/a.md"]);
    // The binding extension was injected into the view.
    expect(cm.dispatched).toHaveLength(1);
    expect(cm.dispatched[0]?.effects).toBeDefined();
  });

  it("on attach, replaces stale editor text with the authoritative CRDT text (cold-restart dup guard)", async () => {
    const { binding, ws, calls } = setup(["notes/a.md"]);
    calls.docText = "CRDT MERGED CONTENT"; // engine reconciled the disk edit into the doc
    const cm = makeCm("STALE DISK CONTENT"); // Obsidian loaded the editor from disk — differs
    ws.setLeaves([makeLeaf("notes/a.md", cm)]);

    await binding.reconcile();

    // The bind dispatch carries a full-document replace to the CRDT text IN THE SAME tx as ySync,
    // so ySync starts with editor === Y.Text and never re-applies the stale editor text into the doc.
    expect(cm.dispatched).toHaveLength(1);
    expect(cm.dispatched[0]?.changes).toEqual({
      from: 0,
      to: "STALE DISK CONTENT".length,
      insert: "CRDT MERGED CONTENT",
    });
    expect(cm.dispatched[0]?.effects).toBeDefined(); // ySync still installed
    expect(cm.docText).toBe("CRDT MERGED CONTENT"); // applied
  });

  it("on attach, makes NO content change when the editor already matches the CRDT", async () => {
    const { binding, ws, calls } = setup(["notes/a.md"]);
    calls.docText = "ALREADY IN SYNC";
    const cm = makeCm("ALREADY IN SYNC");
    ws.setLeaves([makeLeaf("notes/a.md", cm)]);

    await binding.reconcile();

    expect(cm.dispatched).toHaveLength(1);
    expect(cm.dispatched[0]?.changes).toBeUndefined(); // no spurious replace
    expect(cm.dispatched[0]?.effects).toBeDefined();
  });

  it("releases the authority (unbind) when the note fails to attach", async () => {
    const { binding, ws, calls } = setup([]); // not attachable → ensureNoteAttached returns undefined
    const cm = makeCm();
    ws.setLeaves([makeLeaf("notes/x.md", cm)]);

    await binding.reconcile();

    expect(calls.log).toEqual([
      "bind notes/x.md pane-1",
      "attach notes/x.md",
      "unbind notes/x.md pane-1",
    ]);
    expect(cm.dispatched).toHaveLength(0); // no binding injected
  });

  it("skips preview leaves (no mounted CM) and non-markdown leaves", async () => {
    const { binding, ws, calls } = setup(["notes/a.md"]);
    ws.setLeaves([makeLeaf("notes/a.md", null), makeNonMarkdownLeaf()]);

    await binding.reconcile();

    expect(calls.log).toEqual([]); // nothing bound
  });

  it("retries and binds when the CM view mounts AFTER the workspace event (cm-mount gap)", async () => {
    vi.useFakeTimers();
    try {
      const { binding, ws, calls } = setup(["notes/late.md"]);
      const cm = makeCm();
      const leaf = makeLeaf("notes/late.md", null); // markdown + path, CM not mounted yet
      ws.setLeaves([leaf]);

      await binding.reconcile();
      expect(calls.log).toEqual([]); // nothing bound yet — CM absent, a retry is scheduled

      // The EditorView mounts a moment later (full cm shape incl. state.doc):
      (leaf.view as unknown as { editor: { cm?: unknown } }).editor.cm = {
        state: { doc: { toString: () => cm.docText, length: cm.docText.length } },
        dispatch: (s: DispatchSpec) => {
          cm.dispatched.push(s);
          if (s.changes !== undefined) cm.docText = s.changes.insert;
        },
      };
      await vi.advanceTimersByTimeAsync(150); // > MOUNT_RETRY_MS → retry fires → binds

      expect(calls.log).toEqual(["bind notes/late.md pane-1", "attach notes/late.md"]);
      expect(cm.dispatched).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent — re-reconciling an already-bound, unchanged leaf does nothing new", async () => {
    const { binding, ws, calls } = setup(["notes/a.md"]);
    const leaf = makeLeaf("notes/a.md", makeCm());
    ws.setLeaves([leaf]);

    await binding.reconcile();
    const after = [...calls.log];
    await binding.reconcile();

    expect(calls.log).toEqual(after); // no additional bind/attach
  });

  it("unbinds a leaf that closed (removed from the workspace)", async () => {
    const { binding, ws, calls, factoryDestroys } = setup(["notes/a.md"]);
    const cm = makeCm();
    const leaf = makeLeaf("notes/a.md", cm);
    ws.setLeaves([leaf]);
    await binding.reconcile();

    ws.setLeaves([]); // leaf closed
    await binding.reconcile();

    expect(calls.log).toContain("unbind notes/a.md pane-1");
    expect(factoryDestroys()).toBe(1); // binding.destroy() called
    // the compartment was reconfigured to [] (a second dispatch)
    expect(cm.dispatched).toHaveLength(2);
  });

  it("rebinds when a leaf navigates to a different file (same pane id)", async () => {
    const { binding, ws, calls } = setup(["notes/a.md", "notes/b.md"]);
    const cm = makeCm();
    const leaf = makeLeaf("notes/a.md", cm);
    ws.setLeaves([leaf]);
    await binding.reconcile();

    // Same leaf object, different file:
    (leaf.view as unknown as { file: { path: string } }).file = { path: "notes/b.md" };
    await binding.reconcile();

    expect(calls.log).toEqual([
      "bind notes/a.md pane-1",
      "attach notes/a.md",
      "unbind notes/a.md pane-1",
      "bind notes/b.md pane-1",
      "attach notes/b.md",
    ]);
  });

  it("binds the same file in two panes (multi-pane → distinct pane ids)", async () => {
    const { binding, ws, calls } = setup(["notes/a.md"]);
    ws.setLeaves([makeLeaf("notes/a.md", makeCm()), makeLeaf("notes/a.md", makeCm())]);

    await binding.reconcile();

    expect(calls.log).toEqual([
      "bind notes/a.md pane-1",
      "attach notes/a.md",
      "bind notes/a.md pane-2",
      "attach notes/a.md",
    ]);
  });

  it("stop() unbinds every pane and detaches all workspace handlers", async () => {
    const { binding, ws, calls, factoryDestroys } = setup(["notes/a.md", "notes/b.md"]);
    binding.start(); // registers 3 handlers
    ws.setLeaves([makeLeaf("notes/a.md", makeCm()), makeLeaf("notes/b.md", makeCm())]);
    await binding.reconcile();

    binding.stop();

    expect(factoryDestroys()).toBe(2);
    expect(calls.log).toContain("unbind notes/a.md pane-1");
    expect(calls.log).toContain("unbind notes/b.md pane-2");
    expect(ws.offrefCount()).toBe(3); // active-leaf-change + file-open + layout-change
  });

  it("reconcile is a no-op after stop()", async () => {
    const { binding, ws, calls } = setup(["notes/a.md"]);
    binding.start();
    binding.stop();
    ws.setLeaves([makeLeaf("notes/a.md", makeCm())]);

    await binding.reconcile();

    expect(calls.log).toEqual([]);
  });
});
