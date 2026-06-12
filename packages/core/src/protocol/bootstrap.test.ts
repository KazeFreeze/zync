import { describe, it, expect } from "vitest";
import { bootstrapDecision, applyBootstrap } from "./bootstrap.js";
import { BaseStore } from "../bridge/base.js";
import { makeStamp, stampHash } from "./stamp.js";
import { sha256OfText } from "../hash.js";
import { FakeVault } from "../testing/fake-vault.js";
import { MemEngineState } from "../testing/mem-engine-state.js";
import type { DeviceId, DocId, VaultPath } from "../ports.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const DEVICE = "dev-a" as DeviceId;
const SUBSTRATE = "yjs-v1";

describe("bootstrapDecision (design §9.4, prevents the doubled-content landmine)", () => {
  it("no server doc, has local file → this device SEEDS", () => {
    expect(
      bootstrapDecision({
        hasServerDoc: false,
        hasLocalFile: true,
        baseExists: false,
        localEqualsServer: false,
      }),
    ).toBe("seed");
  });
  it("no server doc, no local file → NONE (nothing exists yet — not 'converge')", () => {
    expect(
      bootstrapDecision({
        hasServerDoc: false,
        hasLocalFile: false,
        baseExists: false,
        localEqualsServer: false,
      }),
    ).toBe("none");
  });
  it("server doc exists, no base, local byte-identical to server → ADOPT silently", () => {
    expect(
      bootstrapDecision({
        hasServerDoc: true,
        hasLocalFile: true,
        baseExists: false,
        localEqualsServer: true,
      }),
    ).toBe("adopt-server");
  });
  it("server doc exists, no base, local DIFFERS from server → SUPERVISED IMPORT (never silent merge)", () => {
    expect(
      bootstrapDecision({
        hasServerDoc: true,
        hasLocalFile: true,
        baseExists: false,
        localEqualsServer: false,
      }),
    ).toBe("supervised-import");
  });
  it("server doc + base present → normal CONVERGE (steady state)", () => {
    expect(
      bootstrapDecision({
        hasServerDoc: true,
        hasLocalFile: true,
        baseExists: true,
        localEqualsServer: false,
      }),
    ).toBe("converge");
  });
  it("server doc exists, no local file → ADOPT (new note arriving)", () => {
    expect(
      bootstrapDecision({
        hasServerDoc: true,
        hasLocalFile: false,
        baseExists: false,
        localEqualsServer: false,
      }),
    ).toBe("adopt-server");
  });
});

describe("applyBootstrap (orchestrator — computes inputs from hashes, applies no-attach side effects)", () => {
  function deps(): {
    base: BaseStore;
    engineState: MemEngineState;
    vault: FakeVault;
    baseExists: (id: DocId) => Promise<boolean>;
    substrate: string;
  } {
    const vault = new FakeVault();
    const base = new BaseStore(vault, ".obsidian");
    const engineState = new MemEngineState();
    return {
      base,
      engineState,
      vault,
      baseExists: async (id: DocId) => (await base.load(id)) !== null,
      substrate: SUBSTRATE,
    };
  }

  it("SEED (no server doc, has local file): saves adopt-pending base + markDirty, needsAttach TRUE", async () => {
    const d = deps();
    const id = docId("doc-seed");
    const res = await applyBootstrap(d, {
      path: path("x.md"),
      docId: id,
      localText: "hello world",
      treeStamp: null,
      deviceId: DEVICE,
    });

    expect(res.decision).toBe("seed");
    expect(res.needsAttach).toBe(true);

    const rec = await d.base.load(id);
    expect(rec).not.toBeNull();
    expect(rec?.baseText).toBe("hello world");
    expect(rec?.crdtToken).toBeNull(); // adopt-pending until first attach
    expect(rec?.fileHash).toBe(await sha256OfText("hello world"));
    expect(rec?.substrate).toBe(SUBSTRATE);
    expect(await d.engineState.listDirty()).toEqual([id]);
  });

  it("ADOPT-IDENTICAL (the landmine guard): local byte-identical to server stamp → needsAttach FALSE, base saved, syncedStamp set, ZERO attach", async () => {
    const d = deps();
    const id = docId("doc-adopt");
    const text = "identical content";
    const serverStamp = makeStamp(await sha256OfText(text), "dev-pc" as DeviceId);

    const res = await applyBootstrap(d, {
      path: path("x.md"),
      docId: id,
      localText: text, // byte-identical to what the server stamp hashes
      treeStamp: serverStamp,
      deviceId: DEVICE,
    });

    expect(res.decision).toBe("adopt-server");
    // THE LANDMINE GUARD: zero attach — adopting a byte-identical vault never re-pushes.
    expect(res.needsAttach).toBe(false);

    const rec = await d.base.load(id);
    expect(rec).not.toBeNull();
    expect(rec?.baseText).toBe(text);
    expect(rec?.crdtToken).toBeNull();
    expect(rec?.fileHash).toBe(await sha256OfText(text));

    // synced stamp recorded so lazy-attach sees this doc as already reconciled.
    const synced = await d.engineState.getSyncedStamp(id);
    expect(synced).toBe(serverStamp);
    expect(stampHash(synced ?? "")).toBe(await sha256OfText(text));

    // Adopt is not a local edit: nothing is marked dirty (no push owed).
    expect(await d.engineState.listDirty()).toEqual([]);
  });

  it("ADOPT-NO-LOCAL (server doc, no local file): needsAttach TRUE (must materialize via attach)", async () => {
    const d = deps();
    const id = docId("doc-adopt-nolocal");
    const serverStamp = makeStamp(await sha256OfText("server only"), "dev-pc" as DeviceId);

    const res = await applyBootstrap(d, {
      path: path("x.md"),
      docId: id,
      localText: null,
      treeStamp: serverStamp,
      deviceId: DEVICE,
    });

    expect(res.decision).toBe("adopt-server");
    expect(res.needsAttach).toBe(true);
    // No silent base merge for a doc we have not materialized yet.
    expect(await d.base.load(id)).toBeNull();
    expect(await d.engineState.getSyncedStamp(id)).toBeNull();
  });

  it("SUPERVISED-IMPORT (server doc, no base, local DIFFERS): needsAttach TRUE, NO base merge here", async () => {
    const d = deps();
    const id = docId("doc-divergent");
    const serverStamp = makeStamp(await sha256OfText("the server text"), "dev-pc" as DeviceId);

    const res = await applyBootstrap(d, {
      path: path("x.md"),
      docId: id,
      localText: "a DIFFERENT local text", // hash differs from serverStamp
      treeStamp: serverStamp,
      deviceId: DEVICE,
    });

    expect(res.decision).toBe("supervised-import");
    expect(res.needsAttach).toBe(true);
    // No silent merge: applyBootstrap writes no base for the divergent case (Task 13 attaches then calls supervisedImport).
    expect(await d.base.load(id)).toBeNull();
    expect(await d.engineState.listDirty()).toEqual([]);
  });

  it("NONE (no server doc, no local file): no-op — no base, no dirty, no synced stamp, needsAttach FALSE", async () => {
    const d = deps();
    const id = docId("doc-none");

    const res = await applyBootstrap(d, {
      path: path("x.md"),
      docId: id,
      localText: null,
      treeStamp: null,
      deviceId: DEVICE,
    });

    expect(res.decision).toBe("none");
    expect(res.needsAttach).toBe(false);
    expect(await d.base.load(id)).toBeNull();
    expect(await d.engineState.listDirty()).toEqual([]);
    expect(await d.engineState.getSyncedStamp(id)).toBeNull();
  });

  it("CONVERGE (base already exists): needsAttach reflects stamp inequality (true when local hash ≠ server stamp)", async () => {
    const d = deps();
    const id = docId("doc-converge");
    // Pre-seed a base so baseExists() is true.
    await d.base.save(id, {
      baseText: "old base",
      fileHash: await sha256OfText("old base"),
      crdtToken: null,
      substrate: SUBSTRATE,
    });
    const serverStamp = makeStamp(await sha256OfText("server v2"), "dev-pc" as DeviceId);

    const res = await applyBootstrap(d, {
      path: path("x.md"),
      docId: id,
      localText: "local v1", // differs from server stamp
      treeStamp: serverStamp,
      deviceId: DEVICE,
    });

    expect(res.decision).toBe("converge");
    expect(res.needsAttach).toBe(true);
  });

  it("CONVERGE with local byte-identical to server stamp: needsAttach FALSE (no work owed)", async () => {
    const d = deps();
    const id = docId("doc-converge2");
    const text = "converged content";
    await d.base.save(id, {
      baseText: text,
      fileHash: await sha256OfText(text),
      crdtToken: null,
      substrate: SUBSTRATE,
    });
    const serverStamp = makeStamp(await sha256OfText(text), "dev-pc" as DeviceId);

    const res = await applyBootstrap(d, {
      path: path("x.md"),
      docId: id,
      localText: text,
      treeStamp: serverStamp,
      deviceId: DEVICE,
    });

    expect(res.decision).toBe("converge");
    expect(res.needsAttach).toBe(false);
  });
});
