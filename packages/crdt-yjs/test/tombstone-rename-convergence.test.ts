import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  IndexDoc,
  recordTombstone,
  resolveTombstone,
  applyResurrection,
  applyRenameConflictResolution,
  type TreeEntry,
} from "@zync/core";
import type { DeviceId, DocId, Sha256, VaultPath } from "@zync/core";
import { YjsCrdtMap } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const sha = (s: string): Sha256 => s as Sha256;

/**
 * Real-CRDT convergence for tombstones (edit-beats-delete) and divergent renames.
 * Two `IndexDoc`s over two real `YjsCrdtMap`s with DIFFERENT device ids; updates
 * exchanged by syncing the underlying yDocs directly. The single-replica
 * `FakeCrdtMap` cannot prove these — only a real CRDT merges concurrent writes.
 */
function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function makeReplica(device: string, clientID?: number): { doc: Y.Doc; index: IndexDoc } {
  const doc = new Y.Doc();
  // `Y.Map` resolves concurrent same-key writes by HIGHER clientID (verified
  // deterministic on both replicas). Some tests pin clientIDs so a specific index
  // write wins the LWW register, exercising a specific resolve branch.
  if (clientID !== undefined) doc.clientID = clientID;
  const tree = new YjsCrdtMap<TreeEntry>(doc.getMap<TreeEntry>("tree"));
  return { doc, index: new IndexDoc(tree, device as DeviceId) };
}

describe("tombstone + rename convergence over real YjsCrdtMap", () => {
  it("delete-then-concurrent-offline-edit RESURRECTS identically on both replicas (no content lost)", () => {
    // Pin clientIDs so A's DELETE (the tombstone) wins the LWW index register
    // (higher clientID). This is the hard case: the delete WON the register, yet
    // the concurrent edit must NOT be lost — the resolve logic resurrects it.
    const a = makeReplica("dev-a", 2);
    const b = makeReplica("dev-b", 1);

    // Shared starting state: note.md exists at content H0 on both replicas.
    a.index.setStamp(path("note.md"), docId("doc-n"), "crdt-prose", sha("H0"));
    sync(a.doc, b.doc);
    sync(b.doc, a.doc);

    // CONCURRENT, while partitioned:
    //   A deletes (lays a tombstone remembering H0).
    //   B edits the same note offline → content becomes H1.
    recordTombstone(
      a.index,
      path("note.md"),
      docId("doc-n"),
      "crdt-prose",
      "dev-a" as DeviceId,
      sha("H0"),
    );
    b.index.setStamp(path("note.md"), docId("doc-n"), "crdt-prose", sha("H1"));

    // Heal the partition (exchange both directions).
    sync(a.doc, b.doc);
    sync(b.doc, a.doc);

    // The DELETE won the LWW register (A's higher clientID), so the converged
    // entry is the TOMBSTONE on BOTH replicas — the delete appears to have won.
    expect(a.index.get(path("note.md"))?.deleted).toBe(true);
    expect(b.index.get(path("note.md"))?.deleted).toBe(true);

    // On EACH replica, run the resolve logic against the note's CURRENT content
    // hash H1 (the offline edit). H1 ≠ the tombstone's recorded H0, so BOTH
    // replicas independently decide to RESURRECT — the edit is rescued from a
    // delete that won the register. This is the edit-beats-delete guarantee.
    const currentSha = sha("H1");
    let resurrectionSignals = 0;
    for (const r of [a, b]) {
      const entry = r.index.get(path("note.md"));
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      expect(resolveTombstone(entry, currentSha)).toBe("resurrect");
      applyResurrection(r.index, path("note.md"), entry, currentSha, () => {
        resurrectionSignals += 1;
      });
    }
    // PROOF: BOTH replicas saw the tombstone and fired the resurrection signal.
    // A bare key-drop would lose this — the path would simply vanish, resolve
    // would never run, and the inbox would never learn the note came back.
    expect(resurrectionSignals).toBe(2);

    // Re-exchange any resurrection writes so both converge.
    sync(a.doc, b.doc);
    sync(b.doc, a.doc);

    // BOTH replicas: note.md is LIVE at the edited content H1 — nothing lost.
    for (const r of [a, b]) {
      const live = r.index.liveEntries().map(([p]) => p);
      expect(live).toContain("note.md");
      const entry = r.index.get(path("note.md"));
      expect(entry?.deleted).not.toBe(true);
      expect(entry?.docId).toBe("doc-n");
    }
    expect(a.index.get(path("note.md"))).toEqual(b.index.get(path("note.md")));

    a.doc.destroy();
    b.doc.destroy();
  });

  it("divergent concurrent rename → BOTH converge to the same DETERMINISTIC winner (no split)", () => {
    const a = makeReplica("dev-a");
    const b = makeReplica("dev-b");

    // Shared starting state: x.md (doc-x) on both replicas.
    a.index.setStamp(path("x.md"), docId("doc-x"), "crdt-prose", sha("h"));
    sync(a.doc, b.doc);
    sync(b.doc, a.doc);

    // CONCURRENT divergent rename of the SAME docId to DIFFERENT targets.
    a.index.rename(path("x.md"), path("a.md"));
    b.index.rename(path("x.md"), path("b.md"));

    sync(a.doc, b.doc);
    sync(b.doc, a.doc);

    // After exchange both replicas see TWO live keys for doc-x (a.md and b.md).
    // Run the deterministic resolver on each — both pick the min path (a.md).
    const resA = applyRenameConflictResolution(a.index, docId("doc-x"));
    const resB = applyRenameConflictResolution(b.index, docId("doc-x"));
    expect(resA?.winner).toBe("a.md");
    expect(resB?.winner).toBe("a.md");

    sync(a.doc, b.doc);
    sync(b.doc, a.doc);

    // BOTH replicas converge: a.md live, b.md tombstoned, SAME docId. No split.
    for (const r of [a, b]) {
      const live = r.index.liveEntries().map(([p]) => p);
      expect(live).toContain("a.md");
      expect(live).not.toContain("b.md");
      expect(r.index.get(path("a.md"))?.docId).toBe("doc-x");
    }
    expect(a.index.get(path("a.md"))).toEqual(b.index.get(path("a.md")));
    expect(a.index.get(path("b.md"))).toEqual(b.index.get(path("b.md")));

    a.doc.destroy();
    b.doc.destroy();
  });
});
