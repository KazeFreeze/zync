import { describe, it, expect } from "vitest";
import type { DocId, VaultPath } from "../ports.js";
import { MemEngineState } from "./mem-engine-state.js";

const docId = (s: string): DocId => s as DocId;
const id = (s: string): DocId => s as DocId;
const p = (s: string): VaultPath => s as VaultPath;

describe("MemEngineState (in-memory EngineStateStore for tests)", () => {
  it("set/get synced stamp round-trips", async () => {
    const store = new MemEngineState();
    await store.setSyncedStamp(docId("d1"), "hash:dev");
    expect(await store.getSyncedStamp(docId("d1"))).toBe("hash:dev");
  });

  it("getSyncedStamp of an unknown doc → null", async () => {
    const store = new MemEngineState();
    expect(await store.getSyncedStamp(docId("nope"))).toBeNull();
  });

  it("markDirty then listDirty includes the doc", async () => {
    const store = new MemEngineState();
    await store.markDirty(docId("d1"));
    await store.markDirty(docId("d2"));
    expect((await store.listDirty()).sort()).toEqual(["d1", "d2"]);
  });

  it("clearDirty removes the doc from listDirty", async () => {
    const store = new MemEngineState();
    await store.markDirty(docId("d1"));
    await store.markDirty(docId("d2"));
    await store.clearDirty(docId("d1"));
    expect(await store.listDirty()).toEqual([docId("d2")]);
  });

  it("listDirty is empty by default", async () => {
    const store = new MemEngineState();
    expect(await store.listDirty()).toEqual([]);
  });

  it("isDirty matches listDirty membership (O(1) single-doc check)", async () => {
    const store = new MemEngineState();
    expect(await store.isDirty(docId("d1"))).toBe(false); // unknown → false
    await store.markDirty(docId("d1"));
    expect(await store.isDirty(docId("d1"))).toBe(true);
    expect(await store.isDirty(docId("d2"))).toBe(false); // other doc untouched
    await store.clearDirty(docId("d1"));
    expect(await store.isDirty(docId("d1"))).toBe(false);
  });

  it("lastLivePath round-trips, updates, and clears", async () => {
    const s = new MemEngineState();
    expect(await s.getLastLivePath(id("d"))).toBeNull();
    await s.setLastLivePath(id("d"), p("notes/a.md"));
    expect(await s.getLastLivePath(id("d"))).toBe("notes/a.md");
    await s.setLastLivePath(id("d"), p("notes/b.md"));
    expect(await s.getLastLivePath(id("d"))).toBe("notes/b.md");
    await s.clearLastLivePath(id("d"));
    expect(await s.getLastLivePath(id("d"))).toBeNull();
  });

  it("deleteObserved sets, reads, and clears", async () => {
    const s = new MemEngineState();
    expect(await s.wasDeleted(id("d"))).toBe(false);
    await s.markDeleted(id("d"));
    expect(await s.wasDeleted(id("d"))).toBe(true);
    await s.clearDeleted(id("d"));
    expect(await s.wasDeleted(id("d"))).toBe(false);
  });

  it("the new facets are independent of synced-stamp / dirty", async () => {
    const s = new MemEngineState();
    await s.setSyncedStamp(id("d"), "h:dev");
    await s.markDirty(id("d"));
    await s.setLastLivePath(id("d"), p("x.md"));
    await s.markDeleted(id("d"));
    expect(await s.getSyncedStamp(id("d"))).toBe("h:dev");
    expect(await s.isDirty(id("d"))).toBe(true);
    expect(await s.getLastLivePath(id("d"))).toBe("x.md");
    expect(await s.wasDeleted(id("d"))).toBe(true);
  });
});
