/**
 * IdbDocStore — port-contract tests.
 *
 * `fake-indexeddb/auto` installs an in-memory IndexedDB as the global
 * `indexedDB` so the production code runs unchanged in vitest/Node. Each test
 * uses a UNIQUE db name and deletes it in teardown so state never leaks.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { DocId } from "@zync/core";
import { IdbDocStore } from "./idb-doc-store.js";
import { closeZyncDb, deleteZyncDb, openZyncDb } from "./idb-open.js";

const id = (s: string): DocId => s as DocId;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

let dbCounter = 0;
const openDbs: string[] = [];

async function makeStore(): Promise<{ store: IdbDocStore; name: string }> {
  const name = `zync-docstore-test-${String(dbCounter++)}-${String(Date.now())}`;
  openDbs.push(name);
  const db = await openZyncDb(name);
  return { store: new IdbDocStore(db), name };
}

afterEach(async () => {
  // Close + delete every db opened this run so nothing leaks across tests.
  while (openDbs.length > 0) {
    const name = openDbs.pop();
    if (name === undefined) continue;
    closeZyncDb(name);
    await deleteZyncDb(name);
  }
});

describe("IdbDocStore — load / save / delete / list", () => {
  it("save then load round-trips bytes", async () => {
    const { store } = await makeStore();
    await store.save(id("doc-1"), enc("snapshot-data"));
    const loaded = await store.load(id("doc-1"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("snapshot-data");
  });

  it("round-trips binary bytes identically (incl. zero/high bytes)", async () => {
    const { store } = await makeStore();
    const snap = new Uint8Array([0, 1, 2, 255, 254, 0, 128, 42]);
    await store.save(id("bin"), snap);
    const loaded = await store.load(id("bin"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(Array.from(loaded)).toEqual(Array.from(snap));
  });

  it("load returns null for unknown id", async () => {
    const { store } = await makeStore();
    expect(await store.load(id("unknown"))).toBeNull();
  });

  it("save is idempotent — last write wins", async () => {
    const { store } = await makeStore();
    await store.save(id("doc-1"), enc("v1"));
    await store.save(id("doc-1"), enc("v2"));
    const loaded = await store.load(id("doc-1"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("v2");
  });

  it("delete removes the snapshot", async () => {
    const { store } = await makeStore();
    await store.save(id("doc-del"), enc("bye"));
    await store.delete(id("doc-del"));
    expect(await store.load(id("doc-del"))).toBeNull();
  });

  it("delete is no-op for unknown id (does not throw)", async () => {
    const { store } = await makeStore();
    await expect(store.delete(id("ghost"))).resolves.toBeUndefined();
  });

  it("list returns all stored DocIds", async () => {
    const { store } = await makeStore();
    await store.save(id("a"), enc("a"));
    await store.save(id("b"), enc("b"));
    await store.save(id("c"), enc("c"));
    const ids = (await store.list()).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("list excludes deleted ids", async () => {
    const { store } = await makeStore();
    await store.save(id("keep"), enc("keep"));
    await store.save(id("drop"), enc("drop"));
    await store.delete(id("drop"));
    const ids = await store.list();
    expect(ids).toContain(id("keep"));
    expect(ids).not.toContain(id("drop"));
  });

  it("list returns empty array when nothing saved yet", async () => {
    const { store } = await makeStore();
    expect(await store.list()).toEqual([]);
  });

  it("handles special characters in DocId (e.g. __zync_index__)", async () => {
    const { store } = await makeStore();
    await store.save(id("__zync_index__"), enc("index-snapshot"));
    const loaded = await store.load(id("__zync_index__"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("index-snapshot");
    expect(await store.list()).toContain(id("__zync_index__"));
  });

  it("handles unicode / path-like DocId strings", async () => {
    const { store } = await makeStore();
    const weird = id("folder/sub/note — résumé 🗒️.md");
    await store.save(weird, enc("ok"));
    const loaded = await store.load(weird);
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("ok");
    expect(await store.list()).toContain(weird);
  });

  it("handles a large-ish snapshot (1 MiB)", async () => {
    const { store } = await makeStore();
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    await store.save(id("big"), big);
    const loaded = await store.load(id("big"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) {
      expect(loaded.length).toBe(big.length);
      expect(loaded[0]).toBe(0);
      expect(loaded[255]).toBe(255);
      expect(loaded[big.length - 1]).toBe((big.length - 1) & 0xff);
    }
  });

  it("data persists across a re-open (new store on same db name)", async () => {
    const { store, name } = await makeStore();
    await store.save(id("persisted"), enc("persistent-data"));
    closeZyncDb(name);

    const db2 = await openZyncDb(name);
    const store2 = new IdbDocStore(db2);
    const loaded = await store2.load(id("persisted"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("persistent-data");
  });
});
