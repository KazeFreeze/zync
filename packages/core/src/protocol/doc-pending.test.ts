import { describe, it, expect } from "vitest";
import { isDocStampPending, isDocArriving, partitionPending } from "./doc-pending.js";
import type { SyncSnapshot } from "./doc-pending.js";
import { makeStamp } from "./stamp.js";
import type { DeviceId, DocId, Sha256 } from "../ports.js";

const sha = (h: string) => h as Sha256;
const stamp = (h: string, dev = "devA") => makeStamp(sha(h), dev as DeviceId);

describe("isDocStampPending", () => {
  it("not pending when synced-stamp and disk-hash match the entry stamp (hash-only equality)", () => {
    // same hash, DIFFERENT device suffix must still count equal (the keystone rule)
    expect(
      isDocStampPending(stamp("aaa", "devA"), stamp("aaa", "devB"), stamp("aaa", "devC")),
    ).toBe(false);
  });
  it("pending when the synced stamp differs (not yet acked by the relay)", () => {
    expect(isDocStampPending(stamp("aaa"), stamp("bbb"), stamp("aaa"))).toBe(true);
  });
  it("pending when the disk hash differs (not yet materialized to disk)", () => {
    expect(isDocStampPending(stamp("aaa"), stamp("aaa"), stamp("bbb"))).toBe(true);
  });
  it("pending when there is no synced stamp yet (null)", () => {
    expect(isDocStampPending(stamp("aaa"), null, stamp("aaa"))).toBe(true);
  });
  it("pending when the file is absent on disk (null disk hash)", () => {
    expect(isDocStampPending(stamp("aaa"), stamp("aaa"), null)).toBe(true);
  });
});

describe("isDocArriving", () => {
  it("arriving when the file is absent and the doc is neither stuck nor dirty", () => {
    expect(isDocArriving({ stuck: false, dirty: false, diskHash: null })).toBe(true);
  });
  it("NOT arriving when the doc is stuck, even though the file is absent", () => {
    // A stuck doc is pending forever. Counting it as arriving means the arriving number
    // never drains, which is the exact failure the stuck/syncing split already had to fix.
    expect(isDocArriving({ stuck: true, dirty: false, diskHash: null })).toBe(false);
  });
  it("NOT arriving when the doc is dirty, even though the file is absent", () => {
    // Dirty means this device owes a push. Labelling it arriving inverts the direction.
    expect(isDocArriving({ stuck: false, dirty: true, diskHash: null })).toBe(false);
  });
  it("NOT arriving when the file is present, whatever its hash", () => {
    // A present-but-mismatched file is AMBIGUOUS: it is equally likely to be a newer
    // un-ingested external edit about to be SENT. Absence is the only unambiguous signal.
    expect(isDocArriving({ stuck: false, dirty: false, diskHash: stamp("bbb") })).toBe(false);
  });
  it("NOT arriving when the doc is dirty and the file is present", () => {
    expect(isDocArriving({ stuck: false, dirty: true, diskHash: stamp("bbb") })).toBe(false);
  });
});

describe("partitionPending", () => {
  const d = (s: string) => s as DocId;
  /** Every bucket disjoint from the others, and the three summing to `pending`. */
  const expectPartition = (snap: SyncSnapshot): void => {
    expect(snap.arriving.filter((id) => snap.stuck.includes(id))).toEqual([]);
    expect(snap.sending.filter((id) => snap.stuck.includes(id))).toEqual([]);
    expect(snap.arriving.filter((id) => snap.sending.includes(id))).toEqual([]);
    expect(snap.arriving.length + snap.sending.length + snap.stuck.length).toBe(
      snap.pending.length,
    );
  };

  it("splits a mixed pending set into arriving, sending and stuck that sum to pending", () => {
    const snap = partitionPending({
      pending: [d("in"), d("out"), d("bad")],
      live: [
        { docId: d("in"), diskHash: null }, // absent → inbound
        { docId: d("out"), diskHash: stamp("aaa") }, // on disk → outbound
        { docId: d("bad"), diskHash: null }, // absent BUT stuck
      ],
      dirty: new Set([d("out")]),
      stuck: new Set([d("bad")]),
    });
    expect(snap.arriving).toEqual([d("in")]);
    expect(snap.sending).toEqual([d("out")]);
    expect(snap.stuck).toEqual([d("bad")]);
    expectPartition(snap);
  });

  it("is NOT arriving when the docId is live at two paths and ONE is materialized", () => {
    // A rename re-keys the index as two independent LWW writes, so both keys are briefly live
    // under one docId: the new path holds the file, the old path does not. This is a purely
    // OUTBOUND local rename — reporting it as arriving would invert the direction.
    const snap = partitionPending({
      pending: [d("moved")],
      live: [
        { docId: d("moved"), diskHash: null }, // old key: file gone
        { docId: d("moved"), diskHash: stamp("aaa") }, // new key: file present
      ],
      dirty: new Set(),
      stuck: new Set(),
    });
    expect(snap.arriving).toEqual([]);
    expect(snap.sending).toEqual([d("moved")]);
    expectPartition(snap);
  });

  it("folds the same way whichever order the two live paths are scanned in", () => {
    const snap = partitionPending({
      pending: [d("moved")],
      live: [
        { docId: d("moved"), diskHash: stamp("aaa") }, // materialized key seen FIRST
        { docId: d("moved"), diskHash: null },
      ],
      dirty: new Set(),
      stuck: new Set(),
    });
    expect(snap.arriving).toEqual([]);
    expectPartition(snap);
  });

  it("is arriving only when EVERY live path for the doc is absent", () => {
    const snap = partitionPending({
      pending: [d("moved")],
      live: [
        { docId: d("moved"), diskHash: null },
        { docId: d("moved"), diskHash: null },
      ],
      dirty: new Set(),
      stuck: new Set(),
    });
    expect(snap.arriving).toEqual([d("moved")]);
    expectPartition(snap);
  });

  it("drops a stuck doc that is NOT pending, so the sum still holds", () => {
    // stuckDocIds only clears when pending drains FULLY, so it can outlive the pending set.
    const snap = partitionPending({
      pending: [d("live")],
      live: [{ docId: d("live"), diskHash: stamp("aaa") }],
      dirty: new Set(),
      stuck: new Set([d("live"), d("gone")]),
    });
    expect(snap.stuck).toEqual([d("live")]);
    expect(snap.sending).toEqual([]);
    expectPartition(snap);
  });

  it("drops a would-be-arriving doc that is NOT pending, so the sum still holds", () => {
    const snap = partitionPending({
      pending: [],
      live: [{ docId: d("ghost"), diskHash: null }],
      dirty: new Set(),
      stuck: new Set(),
    });
    expect(snap.arriving).toEqual([]);
    expectPartition(snap);
  });

  it("puts a synthetic rename-target token in sending (no live entry, no classifier)", () => {
    // `pending` carries sources the per-entry classifier never sees. They must reach `sending`
    // through the set difference rather than through clauses of their own.
    const snap = partitionPending({
      pending: [d("rename-target:notes/new.md"), d("orphan-dirty")],
      live: [],
      dirty: new Set([d("orphan-dirty")]),
      stuck: new Set(),
    });
    expect(snap.sending).toEqual([d("rename-target:notes/new.md"), d("orphan-dirty")]);
    expect(snap.arriving).toEqual([]);
    expectPartition(snap);
  });

  it("returns pending unchanged, in the caller's order", () => {
    const pending = [d("c"), d("a"), d("b")];
    const snap = partitionPending({ pending, live: [], dirty: new Set(), stuck: new Set() });
    expect(snap.pending).toEqual([d("c"), d("a"), d("b")]);
  });

  it("returns four empty buckets for an empty pending set", () => {
    const snap = partitionPending({ pending: [], live: [], dirty: new Set(), stuck: new Set() });
    expect(snap).toEqual({ pending: [], arriving: [], sending: [], stuck: [] });
  });
});
