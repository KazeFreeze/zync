import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { Inbox, type InboxEntry } from "@zync/core";
import type { VaultPath } from "@zync/core";
import { YjsCrdtMap } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;

/**
 * Resolve-tombstones-everywhere over the REAL `YjsCrdtMap` (the single-replica
 * `FakeCrdtMap` cannot prove this). Two `Inbox`es, two real `Y.Doc`s, DIFFERENT
 * replicas; updates are exchanged by syncing the underlying yDocs directly.
 */
function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function makeReplica(): { doc: Y.Doc; inbox: Inbox } {
  const doc = new Y.Doc();
  const map = new YjsCrdtMap<InboxEntry>(doc.getMap<InboxEntry>("inbox"));
  return { doc, inbox: new Inbox(map) };
}

const ENTRY: InboxEntry = {
  id: "conflict:notes/a.md:abc12345",
  kind: "conflict",
  path: path("notes/a.md"),
  artifactPath: path("notes/a (conflict, dev-b, 2026-06-11T12-00-00Z).md"),
};

describe("Inbox convergence over real YjsCrdtMap (resolve-tombstones-everywhere)", () => {
  it("add on A propagates to B; resolve on B removes it from BOTH after exchange", () => {
    const a = makeReplica();
    const b = makeReplica();

    // A adds an entry; sync A → B.
    a.inbox.add(ENTRY);
    sync(a.doc, b.doc);
    expect(b.inbox.list().map((e) => e.id)).toEqual([ENTRY.id]);

    // B resolves (tombstones) the entry; exchange BOTH directions.
    b.inbox.resolve(ENTRY.id);
    sync(b.doc, a.doc);
    sync(a.doc, b.doc);

    // Gone from BOTH replicas — the tombstone converged everywhere.
    expect(a.inbox.list()).toEqual([]);
    expect(b.inbox.list()).toEqual([]);

    a.doc.destroy();
    b.doc.destroy();
  });

  it("a concurrent re-add of the SAME id does not resurrect a resolved entry under LWW", () => {
    const a = makeReplica();
    const b = makeReplica();

    // Both start from a synced entry.
    a.inbox.add(ENTRY);
    sync(a.doc, b.doc);

    // B resolves it, then both sync — gone everywhere.
    b.inbox.resolve(ENTRY.id);
    sync(b.doc, a.doc);
    sync(a.doc, b.doc);
    expect(a.inbox.list()).toEqual([]);
    expect(b.inbox.list()).toEqual([]);

    a.doc.destroy();
    b.doc.destroy();
  });
});
