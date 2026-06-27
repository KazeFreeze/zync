import { describe, it, expect, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { DocId, VaultPath } from "@zync/core";
import { FsEngineStateStore } from "./fs-engine-state.js";
import * as fsu from "./fs-utils.js";

const id = (s: string): DocId => s as DocId;
const p = (s: string): VaultPath => s as VaultPath;

async function makeTmpState(): Promise<{ store: FsEngineStateStore; filePath: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-state-test-"));
  const filePath = path.join(dir, "state.json");
  return { store: await FsEngineStateStore.open(filePath), filePath };
}

describe("FsEngineStateStore — getSyncedStamp / setSyncedStamp", () => {
  it("set then get round-trips the stamp", async () => {
    const { store } = await makeTmpState();
    await store.setSyncedStamp(id("d1"), "abc:dev-1");
    expect(await store.getSyncedStamp(id("d1"))).toBe("abc:dev-1");
  });

  it("getSyncedStamp of unknown doc → null", async () => {
    const { store } = await makeTmpState();
    expect(await store.getSyncedStamp(id("unknown"))).toBeNull();
  });

  it("setSyncedStamp updates existing stamp", async () => {
    const { store } = await makeTmpState();
    await store.setSyncedStamp(id("d1"), "old:dev-1");
    await store.setSyncedStamp(id("d1"), "new:dev-1");
    expect(await store.getSyncedStamp(id("d1"))).toBe("new:dev-1");
  });
});

describe("FsEngineStateStore — markDirty / clearDirty / listDirty", () => {
  it("listDirty is empty by default", async () => {
    const { store } = await makeTmpState();
    expect(await store.listDirty()).toEqual([]);
  });

  it("markDirty adds doc to listDirty", async () => {
    const { store } = await makeTmpState();
    await store.markDirty(id("d1"));
    await store.markDirty(id("d2"));
    expect((await store.listDirty()).sort()).toEqual(["d1", "d2"]);
  });

  it("markDirty is idempotent (no duplicates in listDirty)", async () => {
    const { store } = await makeTmpState();
    await store.markDirty(id("d1"));
    await store.markDirty(id("d1"));
    expect((await store.listDirty()).filter((x) => x === id("d1"))).toHaveLength(1);
  });

  it("isDirty matches listDirty membership (O(1) single-doc check)", async () => {
    const { store } = await makeTmpState();
    expect(await store.isDirty(id("d1"))).toBe(false);
    await store.markDirty(id("d1"));
    expect(await store.isDirty(id("d1"))).toBe(true);
    expect(await store.isDirty(id("d2"))).toBe(false);
    await store.clearDirty(id("d1"));
    expect(await store.isDirty(id("d1"))).toBe(false);
  });

  it("clearDirty removes the doc from listDirty", async () => {
    const { store } = await makeTmpState();
    await store.markDirty(id("d1"));
    await store.markDirty(id("d2"));
    await store.clearDirty(id("d1"));
    const dirty = await store.listDirty();
    expect(dirty).not.toContain(id("d1"));
    expect(dirty).toContain(id("d2"));
  });

  it("clearDirty of unknown doc is no-op", async () => {
    const { store } = await makeTmpState();
    await expect(store.clearDirty(id("ghost"))).resolves.toBeUndefined();
    expect(await store.listDirty()).toEqual([]);
  });
});

describe("FsEngineStateStore — crash-survival (re-open)", () => {
  it("dirty entries survive re-open (crash-restart simulation)", async () => {
    const { filePath } = await makeTmpState();
    const store1 = await FsEngineStateStore.open(filePath);
    await store1.markDirty(id("crash-doc"));

    // Simulate process restart by opening a NEW store from the same file.
    const store2 = await FsEngineStateStore.open(filePath);
    expect(await store2.listDirty()).toContain(id("crash-doc"));
  });

  it("synced stamps survive re-open", async () => {
    const { filePath } = await makeTmpState();
    const store1 = await FsEngineStateStore.open(filePath);
    await store1.setSyncedStamp(id("d1"), "abc:dev-1");

    const store2 = await FsEngineStateStore.open(filePath);
    expect(await store2.getSyncedStamp(id("d1"))).toBe("abc:dev-1");
  });

  it("missing file → empty state (first open)", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-state-test-"));
    const store = await FsEngineStateStore.open(path.join(dir, "nonexistent.json"));
    expect(await store.listDirty()).toEqual([]);
    expect(await store.getSyncedStamp(id("x"))).toBeNull();
  });

  it("state file is atomic (no temp files left behind)", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-state-test-"));
    const filePath = path.join(dir, "state.json");
    const store = await FsEngineStateStore.open(filePath);
    await store.markDirty(id("doc"));
    const entries = await fsp.readdir(dir);
    expect(entries.some((n) => n.startsWith(".zync-tmp-"))).toBe(false);
  });

  it("clearDirty survives re-open", async () => {
    const { filePath } = await makeTmpState();
    const store1 = await FsEngineStateStore.open(filePath);
    await store1.markDirty(id("d1"));
    await store1.markDirty(id("d2"));
    await store1.clearDirty(id("d1"));

    const store2 = await FsEngineStateStore.open(filePath);
    expect(await store2.listDirty()).toEqual([id("d2")]);
  });
});

describe("FsEngineStateStore — skip-if-unchanged (no O(n^2) backstop rewrite)", () => {
  it("setLastLivePath / clearDeleted skip the durable write when unchanged", async () => {
    const { store } = await makeTmpState();
    const spy = vi.spyOn(fsu, "atomicWriteBytes");
    try {
      await store.setLastLivePath(id("d"), p("notes/a.md")); // changed → 1 write
      const afterFirst = spy.mock.calls.length;
      expect(afterFirst).toBe(1);

      await store.setLastLivePath(id("d"), p("notes/a.md")); // unchanged → NO write
      expect(spy.mock.calls.length).toBe(afterFirst);

      await store.clearDeleted(id("d")); // never marked → NO write
      expect(spy.mock.calls.length).toBe(afterFirst);

      await store.markDeleted(id("d")); // changed → 1 write
      expect(spy.mock.calls.length).toBe(afterFirst + 1);

      await store.markDeleted(id("d")); // unchanged → NO write
      expect(spy.mock.calls.length).toBe(afterFirst + 1);

      // Behavior is unchanged — final state matches the requested values.
      expect(await store.getLastLivePath(id("d"))).toBe(p("notes/a.md"));
      expect(await store.wasDeleted(id("d"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("clearLastLivePath skips the durable write when already absent", async () => {
    const { store } = await makeTmpState();
    const spy = vi.spyOn(fsu, "atomicWriteBytes");
    try {
      await store.clearLastLivePath(id("ghost")); // never set → NO write
      expect(spy.mock.calls.length).toBe(0);

      await store.setLastLivePath(id("d"), p("notes/a.md")); // 1 write
      await store.clearLastLivePath(id("d")); // present → 1 write
      expect(spy.mock.calls.length).toBe(2);

      await store.clearLastLivePath(id("d")); // now absent → NO write
      expect(spy.mock.calls.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
