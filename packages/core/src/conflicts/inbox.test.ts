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

  describe("resolveMany (bulk dismiss)", () => {
    it("resolves every id in ONE observer fire, not one per id", () => {
      // REGRESSION: bulk dismiss called resolve() in a tight loop, so a large inbox became N CRDT
      // transactions AND N observer cascades on the main thread — which froze Obsidian.
      const map = new FakeCrdtMap<InboxEntry>();
      const inbox = new Inbox(map);
      const ids = ["a", "b", "c", "d", "e"];
      for (const id of ids) inbox.add(entry({ id }));

      const cb = vi.fn();
      map.observe(cb); // subscribe AFTER the adds so we only measure the bulk op
      inbox.resolveMany(ids);

      expect(cb).toHaveBeenCalledTimes(1);
      expect((cb.mock.calls[0]?.[0] as string[]).sort()).toEqual([...ids].sort());
      expect(inbox.list()).toEqual([]); // all actually resolved
    });

    it("is a no-op for unknown ids and tolerates an empty list", () => {
      const map = new FakeCrdtMap<InboxEntry>();
      const inbox = new Inbox(map);
      inbox.add(entry({ id: "real" }));
      const cb = vi.fn();
      map.observe(cb);

      inbox.resolveMany([]); // nothing to do ⇒ no observer noise
      expect(cb).not.toHaveBeenCalled();

      inbox.resolveMany(["ghost", "real"]); // unknown id skipped, real one resolved
      expect(cb).toHaveBeenCalledTimes(1);
      expect(inbox.list()).toEqual([]);
    });
  });
});

/**
 * PROVENANCE. A conflict that cannot say when it formed, on which device, or whether that device
 * was even online and caught up at the time is close to undiagnosable.
 *
 * Reading a real vault's inbox proved the point: 288 entries, and answering "which device made
 * these, and when" took an hour of reverse-engineering millisecond timestamps out of generated
 * FILENAMES. Every one of those questions is answerable at the moment of creation, for free.
 *
 * Stamped in `add()` rather than at the ~7 call sites deliberately: a conflict must not be able to
 * exist WITHOUT provenance, and the one that slips through is exactly the one you will need.
 */
describe("Inbox — provenance stamping", () => {
  const stamp = () => ({
    at: 1_700_000_000_000,
    byDeviceId: "dev-a",
    byDeviceName: "tab-s8",
    connected: false,
    indexSynced: true,
  });

  it("stamps when, which device, and the connectivity at detection", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>(), stamp);
    inbox.add(entry());

    const [e] = inbox.list();
    expect(e?.at).toBe(1_700_000_000_000);
    expect(e?.byDeviceId).toBe("dev-a");
    expect(e?.byDeviceName).toBe("tab-s8");
    expect(e?.connected).toBe(false);
    expect(e?.indexSynced).toBe(true);
  });

  /** The distinguishing question: was this a legitimate divergence, or did we conflict against
   *  state we simply had not received yet? */
  it("records connected=false, which is what separates a real divergence from a stale base", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>(), stamp);
    inbox.add(entry());
    expect(inbox.list()[0]?.connected).toBe(false);
  });

  it("never overwrites a field the caller set explicitly", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>(), stamp);
    inbox.add(entry({ at: 42, byDeviceId: "explicit" }));

    const [e] = inbox.list();
    expect(e?.at).toBe(42);
    expect(e?.byDeviceId).toBe("explicit");
  });

  it("works without a stamper, so existing callers stay valid", () => {
    const inbox = new Inbox(new FakeCrdtMap<InboxEntry>());
    inbox.add(entry());
    expect(inbox.list()[0]?.at).toBeUndefined();
  });
});
