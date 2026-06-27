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
    // baseText survives the round-trip (NEW-7 BLOCKER-1); an OMITTED acked base defaults to the
    // working base on save/load (fully-acked steady-state semantics — 0b-3 crash-window no-loss).
    expect(got).toEqual({ ...rec, ackedText: rec.baseText, ackedHash: rec.fileHash });
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
    expect(await store.load(id("doc-pending"))).toEqual({
      ...rec,
      ackedText: rec.baseText,
      ackedHash: rec.fileHash,
    });
  });
  it("round-trips an EXPLICIT lagging acked base (0b-3 crash-window no-loss)", async () => {
    // The crash-window discipline: the WORKING base advances to an unpushed edit while the
    // ACKED/recovery base stays at the last relay-acked content. Both must survive the round-trip
    // INDEPENDENTLY (not collapse to one), so the post-restart dirty reconcile merges against the
    // genuinely-acked content.
    const v = new FakeVault();
    const store = new BaseStore(v, ".obsidian");
    const rec: BaseRecord = {
      baseText: "edited (unpushed)\n",
      fileHash: sha("h-edit"),
      crdtToken: null,
      substrate: "yjs",
      ackedText: "pristine (last acked)\n",
      ackedHash: sha("h-pristine"),
    };
    await store.save(id("doc-dirty"), rec);
    expect(await store.load(id("doc-dirty"))).toEqual(rec);
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

  it("round-trips materializedHash when present, and keeps it ABSENT when omitted", async () => {
    const v = new FakeVault();
    const store = new BaseStore(v, ".obsidian");
    await store.save(id("doc-mh"), {
      baseText: "body\n",
      fileHash: sha("h1"),
      crdtToken: null,
      substrate: "yjs",
      materializedHash: sha("mh1"),
    });
    expect((await store.load(id("doc-mh")))?.materializedHash).toBe("mh1");

    await store.save(id("doc-none"), {
      baseText: "body\n",
      fileHash: sha("h1"),
      crdtToken: null,
      substrate: "yjs",
    });
    expect((await store.load(id("doc-none")))?.materializedHash).toBeUndefined();
  });

  it("markMaterialized sets ONLY materializedHash and preserves every other field (incl. lagging acked base)", async () => {
    const v = new FakeVault();
    const store = new BaseStore(v, ".obsidian");
    const rec: BaseRecord = {
      baseText: "edited (unpushed)\n",
      fileHash: sha("h-edit"),
      crdtToken: new Uint8Array([7]),
      substrate: "yjs",
      ackedText: "pristine (last acked)\n",
      ackedHash: sha("h-pristine"),
    };
    await store.save(id("doc-x"), rec);
    await store.markMaterialized(id("doc-x"), sha("mh-x"));
    expect(await store.load(id("doc-x"))).toEqual({ ...rec, materializedHash: sha("mh-x") });
  });

  it("markMaterialized is idempotent: a no-op (no write) when the hash is unchanged", async () => {
    const v = new FakeVault();
    const store = new BaseStore(v, ".obsidian");
    await store.save(id("doc-i"), {
      baseText: "b\n",
      fileHash: sha("h"),
      crdtToken: null,
      substrate: "yjs",
      materializedHash: sha("mh"),
    });
    const writes: string[] = [];
    v.onEvent((e) => writes.push(e.path));
    await store.markMaterialized(id("doc-i"), sha("mh"));
    expect(writes).toEqual([]);
  });

  it("markMaterialized on an unknown doc is a no-op (no record created)", async () => {
    const store = new BaseStore(new FakeVault(), ".obsidian");
    await store.markMaterialized(id("ghost"), sha("mh"));
    expect(await store.load(id("ghost"))).toBeNull();
  });
});
