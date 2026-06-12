import { describe, it, expect } from "vitest";
import type { DeviceId, DocId, Sha256, VaultPath } from "../ports.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { IndexDoc, type TreeEntry } from "../protocol/index-doc.js";
import { applyRename, resolveRenameConflict, applyRenameConflictResolution } from "./rename.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const sha = (s: string): Sha256 => s as Sha256;
const DEVICE = "dev-1" as DeviceId;

function makeIndex(device: DeviceId = DEVICE): IndexDoc {
  return new IndexDoc(new FakeCrdtMap<TreeEntry>(), device);
}

describe("rename (0b-2 §B — docId continuity + divergent-rename determinism)", () => {
  it("applyRename preserves the docId; `to` is live, `from` is tombstoned", () => {
    const index = makeIndex();
    index.setStamp(path("old.md"), docId("doc-x"), "crdt-prose", sha("h"));
    const fromDocIdBefore = index.get(path("old.md"))?.docId;

    applyRename(index, path("old.md"), path("new.md"));

    expect(index.get(path("new.md"))?.docId).toBe(fromDocIdBefore); // SAME docId travels
    const live = index.liveEntries().map(([p]) => p);
    expect(live).toContain("new.md");
    expect(live).not.toContain("old.md");
    expect(index.entries().find(([p]) => p === "old.md")?.[1].deleted).toBe(true);
  });

  it("resolveRenameConflict picks the lexicographically-smallest path as the deterministic winner", () => {
    const r = resolveRenameConflict([path("b.md"), path("a.md"), path("c.md")]);
    expect(r.winner).toBe("a.md");
    expect(r.losers.sort()).toEqual(["b.md", "c.md"]);
  });

  it("resolveRenameConflict is order-independent (same winner regardless of input order)", () => {
    const a = resolveRenameConflict([path("a.md"), path("b.md")]);
    const b = resolveRenameConflict([path("b.md"), path("a.md")]);
    expect(a.winner).toBe(b.winner);
    expect(a.winner).toBe("a.md");
  });

  it("applyRenameConflictResolution keeps the winner live and tombstones the losers", () => {
    const index = makeIndex();
    // Two LIVE keys bound to the SAME docId (the divergent-rename end state).
    index.setStamp(path("b.md"), docId("doc-x"), "crdt-prose", sha("h"));
    index.setStamp(path("a.md"), docId("doc-x"), "crdt-prose", sha("h"));

    const res = applyRenameConflictResolution(index, docId("doc-x"));
    expect(res).not.toBeNull();
    expect(res?.winner).toBe("a.md");
    expect(res?.losers).toEqual(["b.md"]);

    const live = index.liveEntries().map(([p]) => p);
    expect(live).toContain("a.md");
    expect(live).not.toContain("b.md");
    // Loser tombstone keeps the SAME docId (no content loss — same doc).
    expect(index.entries().find(([p]) => p === "b.md")?.[1].docId).toBe("doc-x");
  });

  it("applyRenameConflictResolution is idempotent — a second run is a no-op", () => {
    const index = makeIndex();
    index.setStamp(path("b.md"), docId("doc-x"), "crdt-prose", sha("h"));
    index.setStamp(path("a.md"), docId("doc-x"), "crdt-prose", sha("h"));

    const first = applyRenameConflictResolution(index, docId("doc-x"));
    expect(first?.winner).toBe("a.md");

    // Only one live key remains → nothing to resolve → null, state unchanged.
    const second = applyRenameConflictResolution(index, docId("doc-x"));
    expect(second).toBeNull();
    expect(index.liveEntries().map(([p]) => p)).toEqual(["a.md"]);
  });

  it("applyRenameConflictResolution returns null when there is no conflict (≤1 live key)", () => {
    const index = makeIndex();
    index.setStamp(path("a.md"), docId("doc-x"), "crdt-prose", sha("h"));
    expect(applyRenameConflictResolution(index, docId("doc-x"))).toBeNull();
  });
});
