import { describe, it, expect, vi } from "vitest";
import type { VaultPath } from "../ports.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { Inbox, type InboxEntry } from "./inbox.js";

const path = (s: string): VaultPath => s as VaultPath;

function entry(over: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: "conflict:notes/a.md:abc",
    kind: "conflict",
    path: path("notes/a.md"),
    ...over,
  };
}

describe("Inbox (synced over a CrdtMap<InboxEntry>, per-entry LWW)", () => {
  it("add then list shows the entry", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>());
    inbox.add(entry());
    expect(inbox.list()).toEqual([entry()]);
  });

  it("resolve tombstones the entry so it disappears from list()", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>());
    inbox.add(entry());
    inbox.resolve(entry().id);
    expect(inbox.list()).toEqual([]);
  });

  it("list() filters tombstones (deleted === true)", () => {
    const map = new FakeCrdtMap<InboxEntry>();
    const inbox = new Inbox(map);
    inbox.add(entry({ id: "a" }));
    inbox.add(entry({ id: "b" }));
    inbox.resolve("a");
    expect(inbox.list().map((e) => e.id)).toEqual(["b"]);
    // The tombstone is still present in the underlying map (not a key-drop).
    expect(map.get("a")?.deleted).toBe(true);
  });

  it("a duplicate add with the SAME id does not create two entries (idempotent)", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>());
    inbox.add(entry({ id: "dup", detail: "first" }));
    inbox.add(entry({ id: "dup", detail: "second" }));
    expect(inbox.list()).toHaveLength(1);
  });

  it("resolve on a missing id is a no-op (no entry materialised)", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>());
    inbox.resolve("never-added");
    expect(inbox.list()).toEqual([]);
  });

  it("observe fires the changed ids on add and on resolve", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>());
    const cb = vi.fn();
    inbox.observe(cb);
    inbox.add(entry({ id: "x" }));
    inbox.resolve("x");
    expect(cb).toHaveBeenCalledWith(["x"]);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
