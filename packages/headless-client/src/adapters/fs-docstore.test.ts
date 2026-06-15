import { describe, it, expect } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { DocId } from "@zync/core";
import { FsDocStore } from "./fs-docstore.js";

const id = (s: string): DocId => s as DocId;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

async function makeTmpStore(): Promise<{ store: FsDocStore; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-docstore-test-"));
  return { store: new FsDocStore(dir), dir };
}

describe("FsDocStore — load / save / delete / list", () => {
  it("save then load round-trips bytes", async () => {
    const { store } = await makeTmpStore();
    const snap = enc("snapshot-data");
    await store.save(id("doc-1"), snap);
    const loaded = await store.load(id("doc-1"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("snapshot-data");
  });

  it("load returns null for unknown id", async () => {
    const { store } = await makeTmpStore();
    expect(await store.load(id("unknown"))).toBeNull();
  });

  it("save is idempotent — last write wins", async () => {
    const { store } = await makeTmpStore();
    await store.save(id("doc-1"), enc("v1"));
    await store.save(id("doc-1"), enc("v2"));
    const loaded = await store.load(id("doc-1"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("v2");
  });

  it("delete removes the file", async () => {
    const { store } = await makeTmpStore();
    await store.save(id("doc-del"), enc("bye"));
    await store.delete(id("doc-del"));
    expect(await store.load(id("doc-del"))).toBeNull();
  });

  it("delete is no-op for unknown id (does not throw)", async () => {
    const { store } = await makeTmpStore();
    await expect(store.delete(id("ghost"))).resolves.toBeUndefined();
  });

  it("list returns all stored DocIds", async () => {
    const { store } = await makeTmpStore();
    await store.save(id("a"), enc("a"));
    await store.save(id("b"), enc("b"));
    await store.save(id("c"), enc("c"));
    const ids = (await store.list()).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("list excludes deleted ids", async () => {
    const { store } = await makeTmpStore();
    await store.save(id("keep"), enc("keep"));
    await store.save(id("drop"), enc("drop"));
    await store.delete(id("drop"));
    const ids = await store.list();
    expect(ids).toContain(id("keep"));
    expect(ids).not.toContain(id("drop"));
  });

  it("list returns empty array when nothing saved yet", async () => {
    const { store } = await makeTmpStore();
    expect(await store.list()).toEqual([]);
  });

  it("handles special characters in DocId (e.g. __zync_index__)", async () => {
    const { store } = await makeTmpStore();
    const snap = enc("index-snapshot");
    await store.save(id("__zync_index__"), snap);
    const loaded = await store.load(id("__zync_index__"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("index-snapshot");
    const ids = await store.list();
    expect(ids).toContain(id("__zync_index__"));
  });

  it("atomic write leaves no temp files behind", async () => {
    const { store, dir } = await makeTmpStore();
    await store.save(id("clean"), enc("data"));
    const entries = await fsp.readdir(dir);
    expect(entries.some((n) => n.startsWith(".zync-tmp-"))).toBe(false);
  });

  it("store can be re-opened and data persists", async () => {
    const { dir } = await makeTmpStore();
    const store1 = new FsDocStore(dir);
    await store1.save(id("persisted"), enc("persistent-data"));

    const store2 = new FsDocStore(dir);
    const loaded = await store2.load(id("persisted"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("persistent-data");
  });
});
