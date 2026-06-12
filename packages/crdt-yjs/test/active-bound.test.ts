/**
 * Task 12 integration: the ACTIVE-BOUND detach → 3-way merge → rebind path, end to end.
 *
 * A note is OPEN and being typed (its CRDT doc carries the editor's live edits via origin
 * "local-editor"), and an EXTERNAL disk write arrives. In the CRDT/yCollab model the editor
 * FOLLOWS the bound Y.Text, so "rebind" is implicit: applying the ingest 3-way merge to the
 * ATTACHED doc converges the live editor. This wires a REAL YjsCrdtDoc + SimulatedEditor +
 * FileAuthority + IngestPipeline and proves no editor data loss.
 *
 * Behavioral on-device editing (Gboard IME) is the forever-manual Phase-0a gate; the
 * SimulatedEditor is the headless stand-in for that binding.
 */
import { describe, it, expect } from "vitest";
import {
  IngestPipeline,
  type IngestDeps,
  type IngestResult,
  IndexDoc,
  type TreeEntry,
  EchoLedger,
  BaseStore,
  FileAuthority,
  sha256OfText,
} from "@zync/core";
import { FakeVault, FakeCrdtMap, MemEngineState, SimulatedEditor } from "@zync/core/testing";
import type { CrdtDoc, DeviceId, DocId, Route, Sha256, VaultPath, Caps } from "@zync/core";
import { YjsCrdtProvider } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const id = (s: string): DocId => s as DocId;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const CONFIG = ".obsidian";
const NOTE = path("notes/n.md");
const DOC = id("doc-1");
const DEVICE = "dev-test" as DeviceId;
const CAPS: Caps = { maxProseBytes: 1_000_000, configDir: CONFIG };
const BASE = "L1\nL2\nL3\n";

/** Wires real core pieces + a real YjsCrdtDoc + a SimulatedEditor bound to it. */
interface Rig {
  vault: FakeVault;
  base: BaseStore;
  engineState: MemEngineState;
  doc: CrdtDoc;
  authority: FileAuthority;
  pipeline: IngestPipeline;
  bumps: { path: VaultPath; docId: DocId; route: Route; sha: Sha256 }[];
  conflicts: { path: VaultPath; losing: string }[];
  /** Make a new SimulatedEditor pane bound to this doc/authority. */
  editor(paneId: string): SimulatedEditor;
  /** Write disk bytes as an EXTERNAL app would (not echo-recorded). */
  externalWrite(text: string): Promise<void>;
}

async function rig(): Promise<Rig> {
  const vault = new FakeVault();
  const tree = new FakeCrdtMap<TreeEntry>();
  const index = new IndexDoc(tree, DEVICE);
  const echo = new EchoLedger();
  const base = new BaseStore(vault, CONFIG);
  const engineState = new MemEngineState();
  const provider = new YjsCrdtProvider();

  index.setStamp(NOTE, DOC, "crdt-prose", await sha256OfText(BASE));
  await base.save(DOC, {
    baseText: BASE,
    fileHash: await sha256OfText(BASE),
    crdtToken: null,
    substrate: "yjs",
  });

  // The attached doc starts equal to base; the SimulatedEditor types into it live.
  const doc = provider.createDoc(DOC);
  doc.applyEdits([{ at: 0, delete: 0, insert: BASE }], "local-bridge");
  await vault.writeAtomic(NOTE, utf8(BASE));

  const authority = new FileAuthority(NOTE);

  const bumps: Rig["bumps"] = [];
  const conflicts: Rig["conflicts"] = [];

  const deps: IngestDeps = {
    vault,
    index,
    echo,
    base,
    engineState,
    caps: CAPS,
    substrate: "yjs",
    getAttachedDoc: (d) => (d === DOC ? doc : undefined),
    getAuthority: () => authority,
    newDocId: () => id("minted-0"),
    bumpStamp: (p, d, route, sha) => bumps.push({ path: p, docId: d, route, sha }),
    emitConflict: (p, losing) => conflicts.push({ path: p, losing }),
  };

  return {
    vault,
    base,
    engineState,
    doc,
    authority,
    pipeline: new IngestPipeline(deps),
    bumps,
    conflicts,
    editor: (paneId) => new SimulatedEditor(doc, authority, paneId),
    externalWrite: async (text) => {
      await vault.writeAtomic(NOTE, utf8(text));
    },
  };
}

describe("active-bound ingest (detach → 3-way merge → rebind)", () => {
  it("DISJOINT external write → both survive, editor FOLLOWS the merge live", async () => {
    const r = await rig();
    const ed = r.editor("pane-1");
    ed.open(); // active-bound
    // Editor types so the CRDT becomes L1\nL2\nCRDT\n (origin local-editor).
    ed.replaceRange(6, 2, "CRDT"); // "L3" -> "CRDT"
    expect(ed.text()).toBe("L1\nL2\nCRDT\n");

    // An EXTERNAL app rewrites line 1.
    await r.externalWrite("DISK\nL2\nL3\n");

    const res: IngestResult = await r.pipeline.onVaultWrite(NOTE);
    expect(res).toEqual<IngestResult>({
      action: "ingested-clean",
      docId: DOC,
      newText: "DISK\nL2\nCRDT\n",
      activeBound: true,
    });
    // The editor follows the bound doc -> shows the MERGED text. No data loss.
    expect(ed.text()).toBe("DISK\nL2\nCRDT\n");
    // Disk reconciled to the merge; base updated.
    expect(decode((await r.vault.read(NOTE)) ?? new Uint8Array())).toBe("DISK\nL2\nCRDT\n");
    expect((await r.base.load(DOC))?.baseText).toBe("DISK\nL2\nCRDT\n");
    expect(await r.engineState.listDirty()).toEqual([DOC]);
  });

  it("CONFLICT external write → CRDT wins in editor + artifact, no editor data loss", async () => {
    const r = await rig();
    const ed = r.editor("pane-1");
    ed.open();
    // Editor edits line 2 -> CRDT.
    ed.replaceRange(3, 2, "CRDT"); // "L2" -> "CRDT" => "L1\nCRDT\nL3\n"
    expect(ed.text()).toBe("L1\nCRDT\nL3\n");

    // External app edits the SAME line -> conflict.
    await r.externalWrite("L1\nDISK\nL3\n");

    const res: IngestResult = await r.pipeline.onVaultWrite(NOTE);
    expect(res).toEqual<IngestResult>({
      action: "ingested-conflict",
      docId: DOC,
      winningText: "L1\nCRDT\nL3\n",
      losingText: "L1\nDISK\nL3\n",
      activeBound: true,
    });
    // Editor shows the CRDT winner — the user's in-flight edit is NOT clobbered.
    expect(ed.text()).toBe("L1\nCRDT\nL3\n");
    // The disk loser is captured as the conflict artifact.
    expect(r.conflicts).toEqual([{ path: NOTE, losing: "L1\nDISK\nL3\n" }]);
    // Disk rewritten to the winner; base == winner.
    expect(decode((await r.vault.read(NOTE)) ?? new Uint8Array())).toBe("L1\nCRDT\nL3\n");
    expect((await r.base.load(DOC))?.baseText).toBe("L1\nCRDT\nL3\n");
  });

  it("open/close race → after close, external write takes the INACTIVE ingest path", async () => {
    const r = await rig();
    const ed = r.editor("pane-1");
    ed.open();
    ed.replaceRange(6, 2, "CRDT"); // doc -> L1\nL2\nCRDT\n
    ed.close(); // back to inactive

    await r.externalWrite("DISK\nL2\nL3\n");
    const res: IngestResult = await r.pipeline.onVaultWrite(NOTE);
    // Inactive path: same merge, but activeBound false (Task 6 behavior).
    expect(res).toEqual<IngestResult>({
      action: "ingested-clean",
      docId: DOC,
      newText: "DISK\nL2\nCRDT\n",
      activeBound: false,
    });
    expect((await r.base.load(DOC))?.baseText).toBe("DISK\nL2\nCRDT\n");
  });

  it("two-panes binding-set handoff: still active-bound until BOTH panes close", async () => {
    const r = await rig();
    const p1 = r.editor("pane-1");
    const p2 = r.editor("pane-2");
    p1.open();
    p2.open(); // same doc/authority — binding SET has two members
    expect(r.authority.state).toBe("active-bound");

    // Close pane-1: pane-2 still holds it -> STILL active-bound.
    p1.close();
    expect(r.authority.state).toBe("active-bound");

    p1.replaceRange(6, 2, "CRDT"); // doc -> L1\nL2\nCRDT\n (editor edit, either pane)
    await r.externalWrite("DISK\nL2\nL3\n");
    const res1: IngestResult = await r.pipeline.onVaultWrite(NOTE);
    expect(res1.action).toBe("ingested-clean");
    expect(res1).toMatchObject({ activeBound: true });

    // Close pane-2: now INACTIVE -> external write takes the inactive path.
    p2.close();
    expect(r.authority.state).toBe("inactive");
    await r.externalWrite("DISK2\nL2\nCRDT\n"); // disjoint vs current doc (line 1 only)
    const res2: IngestResult = await r.pipeline.onVaultWrite(NOTE);
    expect(res2.action).toBe("ingested-clean");
    expect(res2).toMatchObject({ activeBound: false });
  });
});
