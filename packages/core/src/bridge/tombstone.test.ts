import { describe, it, expect, vi } from "vitest";
import type { DeviceId, DocId, Sha256, VaultPath } from "../ports.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { IndexDoc, type TreeEntry } from "../protocol/index-doc.js";
import { stampHash } from "../protocol/stamp.js";
import { recordTombstone, resolveTombstone, applyResurrection } from "./tombstone.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const sha = (s: string): Sha256 => s as Sha256;
const DEVICE = "dev-1" as DeviceId;

function makeIndex(device: DeviceId = DEVICE): IndexDoc {
  return new IndexDoc(new FakeCrdtMap<TreeEntry>(), device);
}

describe("tombstone (0b-2 §B — edit-beats-delete)", () => {
  it("recordTombstone makes the path a tombstone carrying the delete-time content hash", () => {
    const index = makeIndex();
    index.setStamp(path("note.md"), docId("doc-n"), "crdt-prose", sha("H0"));

    recordTombstone(index, path("note.md"), docId("doc-n"), "crdt-prose", DEVICE, sha("H0"));

    // Gone from the live view, but present (deleted:true) in the full view.
    expect(index.liveEntries().map(([p]) => p)).not.toContain("note.md");
    const entry = index.entries().find(([p]) => p === "note.md")?.[1];
    expect(entry?.deleted).toBe(true);
    expect(entry?.docId).toBe("doc-n");
    expect(entry?.type).toBe("crdt-prose");
    // The tombstone REMEMBERS the content hash at delete time (this is the seam
    // that lets a concurrent edit be detected).
    expect(stampHash(entry?.stamp ?? "")).toBe("H0");
  });

  it("resolveTombstone returns 'delete' when current content hash == the recorded hash", () => {
    const tombstone: TreeEntry = {
      docId: "doc-n" as DocId,
      type: "crdt-prose",
      stamp: "H0:dev-1",
      deleted: true,
    };
    expect(resolveTombstone(tombstone, sha("H0"))).toBe("delete");
  });

  it("resolveTombstone returns 'resurrect' when current hash differs (a concurrent edit)", () => {
    const tombstone: TreeEntry = {
      docId: "doc-n" as DocId,
      type: "crdt-prose",
      stamp: "H0:dev-1",
      deleted: true,
    };
    expect(resolveTombstone(tombstone, sha("H1"))).toBe("resurrect");
  });

  it("resolveTombstone compares HASH PART only (device suffix is never an equality input)", () => {
    const tombstone: TreeEntry = {
      docId: "doc-n" as DocId,
      type: "crdt-prose",
      stamp: "H0:dev-A",
      deleted: true,
    };
    // Same content hash authored by a DIFFERENT device → still a confirmed delete.
    expect(resolveTombstone(tombstone, sha("H0"))).toBe("delete");
  });

  it("applyResurrection re-lists the path live at the new hash AND fires the inbox notice", () => {
    const index = makeIndex();
    index.setStamp(path("note.md"), docId("doc-n"), "crdt-prose", sha("H0"));
    recordTombstone(index, path("note.md"), docId("doc-n"), "crdt-prose", DEVICE, sha("H0"));

    const tombstone = index.get(path("note.md"));
    if (tombstone === undefined) throw new Error("tombstone should exist");
    const onInboxNotice = vi.fn();

    applyResurrection(index, path("note.md"), tombstone, sha("H1"), onInboxNotice);

    // Back in the live view, at the EDITED content hash.
    const live = index.get(path("note.md"));
    expect(index.liveEntries().map(([p]) => p)).toContain("note.md");
    expect(live?.deleted).not.toBe(true);
    expect(live?.docId).toBe("doc-n"); // same docId — content continuity preserved
    expect(stampHash(live?.stamp ?? "")).toBe("H1");

    // The inbox seam is signalled so the user learns the note came back.
    expect(onInboxNotice).toHaveBeenCalledTimes(1);
    expect(onInboxNotice).toHaveBeenCalledWith({
      kind: "resurrected",
      path: path("note.md"),
      docId: docId("doc-n"),
    });
  });
});
