import { describe, it, expect } from "vitest";
import type { DeviceId, DocId, Sha256, VaultPath } from "../ports.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { IndexDoc, type TreeEntry } from "./index-doc.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const sha = (s: string): Sha256 => s as Sha256;
const DEVICE = "dev-1" as DeviceId;

function makeIndex(device: DeviceId = DEVICE): {
  index: IndexDoc;
  tree: FakeCrdtMap<TreeEntry>;
} {
  const tree = new FakeCrdtMap<TreeEntry>();
  return { index: new IndexDoc(tree, device), tree };
}

describe("IndexDoc (0b-2 §B — index tree of content stamps)", () => {
  it("setStamp writes a `${sha}:${deviceId}` stamp that get() returns", () => {
    const { index } = makeIndex();
    index.setStamp(path("a.md"), docId("doc-a"), "crdt-prose", sha("hashA"));

    const entry = index.get(path("a.md"));
    expect(entry).toEqual({
      docId: "doc-a",
      type: "crdt-prose",
      stamp: "hashA:dev-1",
    });
    expect(entry?.stamp).toBe("hashA:dev-1");
  });

  it("rename moves the entry to the new key with the SAME docId and clears the old key from liveEntries", () => {
    const { index } = makeIndex();
    index.setStamp(path("old.md"), docId("doc-x"), "crdt-prose", sha("h"));
    index.rename(path("old.md"), path("new.md"));

    const moved = index.get(path("new.md"));
    expect(moved?.docId).toBe("doc-x"); // SAME docId travels with the rename
    expect(moved?.type).toBe("crdt-prose");

    const livePaths = index.liveEntries().map(([p]) => p);
    expect(livePaths).toContain("new.md");
    expect(livePaths).not.toContain("old.md"); // old key gone from live view
  });

  it("delete writes a TOMBSTONE: excluded from liveEntries, present (deleted:true) in entries", () => {
    const { index } = makeIndex();
    index.setStamp(path("gone.md"), docId("doc-g"), "crdt-prose", sha("h"));
    index.delete(path("gone.md"));

    expect(index.liveEntries().map(([p]) => p)).not.toContain("gone.md");

    const all = index.entries();
    const found = all.find(([p]) => p === "gone.md");
    expect(found).toBeDefined();
    expect(found?.[1].deleted).toBe(true);
    expect(found?.[1].docId).toBe("doc-g"); // docId/type kept so Task 8 can LWW-resurrect
  });

  it("delete of a path with no prior entry lays a minimal tombstone", () => {
    const { index } = makeIndex();
    index.delete(path("never.md"));

    expect(index.liveEntries().map(([p]) => p)).not.toContain("never.md");
    const found = index.entries().find(([p]) => p === "never.md");
    expect(found?.[1].deleted).toBe(true);
  });

  it("observe fires with the changed paths on setStamp", () => {
    const { index } = makeIndex();
    const seen: VaultPath[][] = [];
    const unsub = index.observe((paths) => seen.push(paths));

    index.setStamp(path("b.md"), docId("doc-b"), "crdt-prose", sha("h"));
    expect(seen).toEqual([["b.md"]]);

    unsub();
    index.setStamp(path("c.md"), docId("doc-c"), "crdt-prose", sha("h"));
    expect(seen).toEqual([["b.md"]]); // no further events after unsubscribe
  });

  it("liveEntries excludes tombstones; entries includes them", () => {
    const { index } = makeIndex();
    index.setStamp(path("live.md"), docId("d1"), "crdt-prose", sha("h"));
    index.setStamp(path("dead.md"), docId("d2"), "crdt-prose", sha("h"));
    index.delete(path("dead.md"));

    expect(
      index
        .liveEntries()
        .map(([p]) => p)
        .sort(),
    ).toEqual(["live.md"]);
    expect(
      index
        .entries()
        .map(([p]) => p)
        .sort(),
    ).toEqual(["dead.md", "live.md"]);
  });
});
