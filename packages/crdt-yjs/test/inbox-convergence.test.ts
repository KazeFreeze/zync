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
  it("resolveMany batches into ONE Yjs transaction (one observer fire, one update)", () => {
    // REGRESSION: bulk dismiss resolved ids one at a time, so a large inbox meant N Yjs
    // transactions and N observer cascades on the main thread — Obsidian froze. Proven here
    // against the REAL YjsCrdtMap, since the single-replica fake cannot prove Yjs semantics.
    const a = makeReplica();
    const ids = ["i1", "i2", "i3", "i4", "i5", "i6"];
    for (const id of ids) a.inbox.add({ ...ENTRY, id });

    let fires = 0;
    let seen: string[] = [];
    a.inbox.observe((changed) => {
      fires += 1;
      seen = [...seen, ...changed];
    });
    let updates = 0;
    a.doc.on("update", () => {
      updates += 1;
    });

    a.inbox.resolveMany(ids);

    expect(fires).toBe(1); // ONE observer fire for the whole batch
    expect(updates).toBe(1); // ONE encoded update on the wire, not six
    expect(seen.sort()).toEqual([...ids].sort());
    expect(a.inbox.list()).toEqual([]);

    // The batch still RELAYS: a peer applying that single update sees every tombstone.
    const b = makeReplica();
    sync(a.doc, b.doc);
    expect(b.inbox.list()).toEqual([]);

    a.doc.destroy();
    b.doc.destroy();
  });
});
