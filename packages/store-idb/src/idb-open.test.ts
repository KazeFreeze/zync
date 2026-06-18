/**
 * Shared-DB tests — both adapters live in ONE IndexedDB database (the plugin
 * opens exactly one db). Verifies the `docs` and `engine_state` stores are
 * independent (no key collision) and that everything survives a reopen together.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { DocId } from "@zync/core";
import { IdbDocStore } from "./idb-doc-store.js";
import { IdbEngineState } from "./idb-engine-state.js";
import { closeZyncDb, deleteZyncDb, openZyncDb } from "./idb-open.js";

const id = (s: string): DocId => s as DocId;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

let dbCounter = 0;
const openDbs: string[] = [];

function uniqueName(): string {
  const name = `zync-shared-test-${String(dbCounter++)}-${String(Date.now())}`;
  openDbs.push(name);
  return name;
}

afterEach(async () => {
  while (openDbs.length > 0) {
    const name = openDbs.pop();
    if (name === undefined) continue;
    closeZyncDb(name);
    await deleteZyncDb(name);
  }
});

describe("shared single-DB — DocStore + EngineState coexist", () => {
  it("both adapters share one db handle without colliding", async () => {
    const name = uniqueName();
    const db = await openZyncDb(name);
    const docs = new IdbDocStore(db);
    const state = new IdbEngineState(db);

    // Same key in both adapters must address DIFFERENT stores.
    await docs.save(id("note"), enc("snapshot"));
    await state.setSyncedStamp(id("note"), "h:dev-1");
    await state.markDirty(id("note"));

    const loaded = await docs.load(id("note"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("snapshot");
    expect(await state.getSyncedStamp(id("note"))).toBe("h:dev-1");
    expect(await docs.list()).toEqual([id("note")]);
    expect(await state.listDirty()).toEqual([id("note")]);
  });

  it("deleting a doc snapshot does not touch its engine-state", async () => {
    const name = uniqueName();
    const db = await openZyncDb(name);
    const docs = new IdbDocStore(db);
    const state = new IdbEngineState(db);

    await docs.save(id("note"), enc("snapshot"));
    await state.setSyncedStamp(id("note"), "h:dev-1");

    await docs.delete(id("note"));

    expect(await docs.load(id("note"))).toBeNull();
    // EngineState is a SEPARATE concern — the DocStore delete leaves it intact.
    expect(await state.getSyncedStamp(id("note"))).toBe("h:dev-1");
  });

  it("both stores survive a shared reopen", async () => {
    const name = uniqueName();
    const db = await openZyncDb(name);
    const docs = new IdbDocStore(db);
    const state = new IdbEngineState(db);

    await docs.save(id("note"), enc("snapshot"));
    await state.markDirty(id("note"));
    await state.setSyncedStamp(id("note"), "h:dev-1");
    closeZyncDb(name);

    const db2 = await openZyncDb(name);
    const docs2 = new IdbDocStore(db2);
    const state2 = new IdbEngineState(db2);

    const loaded = await docs2.load(id("note"));
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("snapshot");
    expect(await state2.listDirty()).toEqual([id("note")]);
    expect(await state2.getSyncedStamp(id("note"))).toBe("h:dev-1");
  });
});
