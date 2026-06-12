import { describe, it, expect } from "vitest";
import { BaseStore, type BaseRecord } from "./base.js";
import { FakeVault } from "../testing/fake-vault.js";
import type { DocId, Sha256 } from "../ports.js";

const id = (s: string) => s as DocId;
const sha = (s: string) => s as Sha256;

describe("BaseStore", () => {
  it("round-trips a base record INCLUDING the merge base text, under .obsidian/zync/base/", async () => {
    const v = new FakeVault();
    const store = new BaseStore(v, ".obsidian");
    const rec: BaseRecord = {
      baseText: "line1\nline2\n",
      fileHash: sha("h1"),
      crdtToken: new Uint8Array([1, 2, 3]),
      substrate: "yjs",
    };
    await store.save(id("doc1"), rec);
    const got = await store.load(id("doc1"));
    expect(got).toEqual(rec); // baseText survives the round-trip (NEW-7 BLOCKER-1)
    expect((await v.list()).map((f) => f.path)).toContain(".obsidian/zync/base/doc1.json");
  });
  it("round-trips an adopt-pending record (crdtToken === null, 0b-2 §B)", async () => {
    const v = new FakeVault();
    const store = new BaseStore(v, ".obsidian");
    const rec: BaseRecord = {
      baseText: "adopted body\n",
      fileHash: sha("h-adopt"),
      crdtToken: null, // pending: nothing attached yet
      substrate: "yjs",
    };
    await store.save(id("doc-pending"), rec);
    expect(await store.load(id("doc-pending"))).toEqual(rec);
  });
  it("returns null for an unknown doc", async () => {
    const store = new BaseStore(new FakeVault(), ".obsidian");
    expect(await store.load(id("nope"))).toBeNull();
  });
  it("save writes base BEFORE the note file (ordering invariant)", async () => {
    const v = new FakeVault();
    const order: string[] = [];
    v.onEvent((e) => order.push(e.path));
    const store = new BaseStore(v, ".obsidian");
    await store.saveThenFile(
      id("doc1"),
      { baseText: "body", fileHash: sha("h2"), crdtToken: new Uint8Array([9]), substrate: "yjs" },
      "notes/a.md" as never,
      new TextEncoder().encode("body"),
    );
    expect(order).toEqual([".obsidian/zync/base/doc1.json", "notes/a.md"]);
  });
});
