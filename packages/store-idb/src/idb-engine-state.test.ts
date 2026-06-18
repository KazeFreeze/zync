/**
 * IdbEngineState — port-contract + crash-survival tests.
 *
 * The load-bearing property is REOPEN SURVIVAL: state written through one
 * adapter, after the db handle is closed, must still be there when a fresh
 * adapter reopens the SAME db name (the engine's crash-restart guarantee).
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { DocId } from "@zync/core";
import { IdbEngineState } from "./idb-engine-state.js";
import { closeZyncDb, deleteZyncDb, openZyncDb } from "./idb-open.js";

const id = (s: string): DocId => s as DocId;

let dbCounter = 0;
const openDbs: string[] = [];

async function makeState(): Promise<{ store: IdbEngineState; name: string }> {
  const name = `zync-state-test-${String(dbCounter++)}-${String(Date.now())}`;
  openDbs.push(name);
  const db = await openZyncDb(name);
  return { store: new IdbEngineState(db), name };
}

async function reopenState(name: string): Promise<IdbEngineState> {
  const db = await openZyncDb(name);
  return new IdbEngineState(db);
}

afterEach(async () => {
  while (openDbs.length > 0) {
    const name = openDbs.pop();
    if (name === undefined) continue;
    closeZyncDb(name);
    await deleteZyncDb(name);
  }
});

describe("IdbEngineState — getSyncedStamp / setSyncedStamp", () => {
  it("set then get round-trips the stamp", async () => {
    const { store } = await makeState();
    await store.setSyncedStamp(id("d1"), "abc:dev-1");
    expect(await store.getSyncedStamp(id("d1"))).toBe("abc:dev-1");
  });

  it("getSyncedStamp of unknown doc → null", async () => {
    const { store } = await makeState();
    expect(await store.getSyncedStamp(id("unknown"))).toBeNull();
  });

  it("setSyncedStamp updates existing stamp", async () => {
    const { store } = await makeState();
    await store.setSyncedStamp(id("d1"), "old:dev-1");
    await store.setSyncedStamp(id("d1"), "new:dev-1");
    expect(await store.getSyncedStamp(id("d1"))).toBe("new:dev-1");
  });

  it("setSyncedStamp does not mark the doc dirty", async () => {
    const { store } = await makeState();
    await store.setSyncedStamp(id("d1"), "abc:dev-1");
    expect(await store.listDirty()).toEqual([]);
  });
});

describe("IdbEngineState — markDirty / clearDirty / listDirty", () => {
  it("listDirty is empty by default", async () => {
    const { store } = await makeState();
    expect(await store.listDirty()).toEqual([]);
  });

  it("markDirty adds doc to listDirty", async () => {
    const { store } = await makeState();
    await store.markDirty(id("d1"));
    await store.markDirty(id("d2"));
    expect((await store.listDirty()).sort()).toEqual(["d1", "d2"]);
  });

  it("markDirty is idempotent (set semantics — no duplicates)", async () => {
    const { store } = await makeState();
    await store.markDirty(id("d1"));
    await store.markDirty(id("d1"));
    expect((await store.listDirty()).filter((x) => x === id("d1"))).toHaveLength(1);
  });

  it("clearDirty removes the doc from listDirty", async () => {
    const { store } = await makeState();
    await store.markDirty(id("d1"));
    await store.markDirty(id("d2"));
    await store.clearDirty(id("d1"));
    const dirty = await store.listDirty();
    expect(dirty).not.toContain(id("d1"));
    expect(dirty).toContain(id("d2"));
  });

  it("clearDirty of unknown doc is no-op", async () => {
    const { store } = await makeState();
    await expect(store.clearDirty(id("ghost"))).resolves.toBeUndefined();
    expect(await store.listDirty()).toEqual([]);
  });

  it("markDirty then clearDirty preserves an existing synced stamp", async () => {
    const { store } = await makeState();
    await store.setSyncedStamp(id("d1"), "abc:dev-1");
    await store.markDirty(id("d1"));
    await store.clearDirty(id("d1"));
    expect(await store.getSyncedStamp(id("d1"))).toBe("abc:dev-1");
    expect(await store.listDirty()).toEqual([]);
  });
});

describe("IdbEngineState — crash-survival (reopen)", () => {
  it("dirty entries survive reopen (crash-restart simulation)", async () => {
    const { store, name } = await makeState();
    await store.markDirty(id("crash-doc"));
    closeZyncDb(name);

    const store2 = await reopenState(name);
    expect(await store2.listDirty()).toContain(id("crash-doc"));
  });

  it("synced stamps survive reopen", async () => {
    const { store, name } = await makeState();
    await store.setSyncedStamp(id("d1"), "abc:dev-1");
    closeZyncDb(name);

    const store2 = await reopenState(name);
    expect(await store2.getSyncedStamp(id("d1"))).toBe("abc:dev-1");
  });

  it("clearDirty survives reopen", async () => {
    const { store, name } = await makeState();
    await store.markDirty(id("d1"));
    await store.markDirty(id("d2"));
    await store.clearDirty(id("d1"));
    closeZyncDb(name);

    const store2 = await reopenState(name);
    expect((await store2.listDirty()).sort()).toEqual(["d2"]);
  });

  it("fresh db → empty state (first open)", async () => {
    const { store } = await makeState();
    expect(await store.listDirty()).toEqual([]);
    expect(await store.getSyncedStamp(id("x"))).toBeNull();
  });

  it("isDirty is an O(1) single-key check that matches listDirty membership", async () => {
    const { store } = await makeState();
    expect(await store.isDirty(id("d1"))).toBe(false); // absent record → false
    await store.markDirty(id("d1"));
    await store.setSyncedStamp(id("d2"), "abc:dev-1"); // present but NOT dirty
    expect(await store.isDirty(id("d1"))).toBe(true);
    expect(await store.isDirty(id("d2"))).toBe(false); // record exists, dirty:false
    await store.clearDirty(id("d1"));
    expect(await store.isDirty(id("d1"))).toBe(false);
  });
});
