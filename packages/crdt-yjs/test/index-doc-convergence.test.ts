import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { IndexDoc, type TreeEntry } from "@zync/core";
import type { DeviceId, DocId, Sha256, VaultPath } from "@zync/core";
import { YjsCrdtMap } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const sha = (s: string): Sha256 => s as Sha256;

/**
 * Convergence of the index `tree` over the REAL `YjsCrdtMap` (the single-replica
 * `FakeCrdtMap` cannot prove this). Two `IndexDoc`s, two real `Y.Doc`s, DIFFERENT
 * device ids; updates are exchanged by syncing the underlying yDocs directly.
 */
function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function makeReplica(device: string): { doc: Y.Doc; index: IndexDoc } {
  const doc = new Y.Doc();
  const tree = new YjsCrdtMap<TreeEntry>(doc.getMap<TreeEntry>("tree"));
  return { doc, index: new IndexDoc(tree, device as DeviceId) };
}

describe("IndexDoc convergence over real YjsCrdtMap (per-key LWW)", () => {
  it("disjoint bumps: both replicas see both paths after exchange (no lost change)", () => {
    const a = makeReplica("dev-a");
    const b = makeReplica("dev-b");

    a.index.setStamp(path("a.md"), docId("doc-a"), "crdt-prose", sha("hashA"));
    b.index.setStamp(path("b.md"), docId("doc-b"), "crdt-prose", sha("hashB"));

    // Exchange both directions.
    sync(a.doc, b.doc);
    sync(b.doc, a.doc);

    const pathsA = a.index
      .liveEntries()
      .map(([p]) => p)
      .sort();
    const pathsB = b.index
      .liveEntries()
      .map(([p]) => p)
      .sort();
    expect(pathsA).toEqual(["a.md", "b.md"]);
    expect(pathsB).toEqual(["a.md", "b.md"]);

    a.doc.destroy();
    b.doc.destroy();
  });

  it("same-path concurrent bump: LWW converges to ONE identical winning entry (no split)", () => {
    const a = makeReplica("dev-a");
    const b = makeReplica("dev-b");

    // Both stamp the SAME path concurrently with different sha + device.
    a.index.setStamp(path("shared.md"), docId("doc-a"), "crdt-prose", sha("hashFromA"));
    b.index.setStamp(path("shared.md"), docId("doc-b"), "crdt-prose", sha("hashFromB"));

    sync(a.doc, b.doc);
    sync(b.doc, a.doc);

    const winA = a.index.get(path("shared.md"));
    const winB = b.index.get(path("shared.md"));

    // Both replicas agree on ONE identical TreeEntry — deterministic LWW, no split.
    expect(winA).toBeDefined();
    expect(winA).toEqual(winB);
    // The winner is one of the two authored stamps (not a merge of both).
    expect(["hashFromA:dev-a", "hashFromB:dev-b"]).toContain(winA?.stamp);

    a.doc.destroy();
    b.doc.destroy();
  });
});
