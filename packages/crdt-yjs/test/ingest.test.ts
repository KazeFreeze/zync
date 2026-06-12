import { describe, it, expect } from "vitest";
import {
  IngestPipeline,
  type IngestDeps,
  type IngestResult,
  IndexDoc,
  type TreeEntry,
  EchoLedger,
  BaseStore,
  FileAuthority,
  diffToEdits,
  sha256OfBytes,
  sha256OfText,
} from "@zync/core";
import { FakeVault, FakeCrdtMap, MemEngineState } from "@zync/core/testing";
import type { CrdtDoc, DeviceId, DocId, Route, Sha256, VaultPath, Caps } from "@zync/core";
import { YjsCrdtProvider } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const id = (s: string): DocId => s as DocId;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const CONFIG = ".obsidian";
const NOTE = path("notes/n.md");
const DOC = id("doc-1");
const DEVICE = "dev-test" as DeviceId;
const CAPS: Caps = { maxProseBytes: 1_000_000, configDir: CONFIG };

/** A test harness wiring real core pieces + a real YjsCrdtDoc on the CRDT side. */
interface Harness {
  vault: FakeVault;
  index: IndexDoc;
  echo: EchoLedger;
  base: BaseStore;
  engineState: MemEngineState;
  provider: YjsCrdtProvider;
  doc: CrdtDoc | undefined;
  pipeline: IngestPipeline;
  // recording stubs
  bumps: { path: VaultPath; docId: DocId; route: Route; sha: Sha256 }[];
  conflicts: { path: VaultPath; losing: string }[];
  mintedIds: DocId[];
  // FakeVault write log to prove echo-record-before-write ordering
  writeLog: VaultPath[];
}

interface SetupOpts {
  base?: string; // baseRec.baseText (also seeds base.fileHash)
  disk?: string; // current disk bytes written to the note
  crdt?: string; // text inserted into the attached YjsCrdtDoc
  attach?: boolean; // attach a CRDT doc? (false ⇒ adopt-pending)
  indexType?: Route; // TreeEntry.type (sticky classify)
  recordEchoFor?: string; // pre-record an echo for the disk text (echo-skip case)
  authorityBound?: boolean; // FileAuthority active-bound (detach-merge-rebind)
  writeNote?: boolean; // write the note file at all? (false ⇒ deleted)
}

async function setup(opts: SetupOpts): Promise<Harness> {
  const {
    base: baseText = "",
    disk = "",
    crdt,
    attach = true,
    indexType = "crdt-prose",
    recordEchoFor,
    authorityBound = false,
    writeNote = true,
  } = opts;

  const vault = new FakeVault();
  const tree = new FakeCrdtMap<TreeEntry>();
  const index = new IndexDoc(tree, DEVICE);
  const echo = new EchoLedger();
  const baseStore = new BaseStore(vault, CONFIG);
  const engineState = new MemEngineState();
  const provider = new YjsCrdtProvider();

  // Pre-seed the index entry (docId, type, stamp).
  index.setStamp(NOTE, DOC, indexType, await sha256OfText(baseText));

  // Pre-seed the base record.
  await baseStore.save(DOC, {
    baseText,
    fileHash: await sha256OfText(baseText),
    crdtToken: null,
    substrate: "yjs",
  });

  // Optionally attach a CRDT doc whose text == the intended `crdt` side.
  let doc: CrdtDoc | undefined;
  if (attach) {
    doc = provider.createDoc(DOC);
    const target = crdt ?? baseText;
    if (target !== "") doc.applyEdits(diffToEdits("", target), "local-bridge");
  }

  // Write the disk variant (this is the state onVaultWrite sees).
  if (writeNote) await vault.writeAtomic(NOTE, utf8(disk));

  // Pre-record an echo for the on-disk bytes (echo-skip case).
  if (recordEchoFor !== undefined) {
    echo.recordWrite(NOTE, await sha256OfBytes(utf8(recordEchoFor)));
  }

  const authority = new FileAuthority(NOTE);
  if (authorityBound) authority.bindEditor("pane-1");

  const bumps: Harness["bumps"] = [];
  const conflicts: Harness["conflicts"] = [];
  const mintedIds: DocId[] = [];
  const writeLog: VaultPath[] = [];
  vault.onEvent((e) => writeLog.push(e.path));

  const deps: IngestDeps = {
    vault,
    index,
    echo,
    base: baseStore,
    engineState,
    caps: CAPS,
    substrate: "yjs",
    getAttachedDoc: (d) => (doc !== undefined && d === DOC ? doc : undefined),
    getAuthority: () => authority,
    newDocId: () => {
      const minted = id(`minted-${String(mintedIds.length)}`);
      mintedIds.push(minted);
      return minted;
    },
    bumpStamp: (p, d, route, sha) => bumps.push({ path: p, docId: d, route, sha }),
    emitConflict: (p, losing) => conflicts.push({ path: p, losing }),
  };

  return {
    vault,
    index,
    echo,
    base: baseStore,
    engineState,
    provider,
    doc,
    pipeline: new IngestPipeline(deps),
    bumps,
    conflicts,
    mintedIds,
    writeLog,
  };
}

describe("IngestPipeline.onVaultWrite (file → CRDT)", () => {
  let h: Harness;

  it("skipped-deleted: read returns null", async () => {
    h = await setup({ base: "X\n", writeNote: false });
    const r = await h.pipeline.onVaultWrite(NOTE);
    expect(r).toEqual<IngestResult>({ action: "skipped-deleted" });
    expect(h.bumps).toHaveLength(0);
    expect(await h.engineState.listDirty()).toHaveLength(0);
  });

  it("skipped-not-prose: index type binary-blob short-circuits", async () => {
    h = await setup({ base: "X\n", disk: "Y\n", indexType: "binary-blob" });
    const r = await h.pipeline.onVaultWrite(NOTE);
    expect(r).toEqual<IngestResult>({ action: "skipped-not-prose" });
    expect(h.bumps).toHaveLength(0);
    expect(await h.engineState.listDirty()).toHaveLength(0);
  });

  it("skipped-echo: our own write — echo consumed first, nothing else happens", async () => {
    const diskText = "L1\nDISK\nL3\n";
    h = await setup({
      base: "L1\nL2\nL3\n",
      disk: diskText,
      crdt: "L1\nL2\nL3\n",
      recordEchoFor: diskText,
    });
    const r = await h.pipeline.onVaultWrite(NOTE);
    expect(r).toEqual<IngestResult>({ action: "skipped-echo" });
    // echo entry consumed ⇒ a SECOND identical event would now be external
    expect(h.echo.isEcho(NOTE, await sha256OfText(diskText))).toBe(false);
    // base / markDirty / bump all untouched
    expect(h.bumps).toHaveLength(0);
    expect(await h.engineState.listDirty()).toHaveLength(0);
    expect((await h.base.load(DOC))?.baseText).toBe("L1\nL2\nL3\n");
  });

  it("active-bound (Task 12): detach-merge-rebind runs the merge into the attached doc", async () => {
    // Disjoint edits: disk touches line 1, the editor's CRDT touches line 3.
    const baseT = "L1\nL2\nL3\n";
    const diskT = "DISK\nL2\nL3\n";
    const crdtT = "L1\nL2\nCRDT\n";
    const mergedT = "DISK\nL2\nCRDT\n";
    h = await setup({ base: baseT, disk: diskT, crdt: crdtT, authorityBound: true });
    const r = await h.pipeline.onVaultWrite(NOTE);
    // No longer deferred: the active-bound path runs the SAME merge, tagged activeBound.
    expect(r).toEqual<IngestResult>({
      action: "ingested-clean",
      docId: DOC,
      newText: mergedT,
      activeBound: true,
    });
    // The attached doc (which the editor follows) converged to the merge.
    expect(h.doc?.getText()).toBe(mergedT);
    // base updated, markDirty + bumpStamp now fire (they did NOT when deferred).
    expect((await h.base.load(DOC))?.baseText).toBe(mergedT);
    expect(await h.engineState.listDirty()).toEqual([DOC]);
    expect(h.bumps).toHaveLength(1);
    expect(h.bumps[0]?.sha).toBe(await sha256OfText(mergedT));
  });

  it("only-disk (crdt==base): clean, doc adopts disk, disk NOT rewritten", async () => {
    const baseT = "L1\nL2\nL3\n";
    const diskT = "L1\nDISK\nL3\n";
    h = await setup({ base: baseT, disk: diskT, crdt: baseT });
    const r = await h.pipeline.onVaultWrite(NOTE);
    expect(r).toEqual<IngestResult>({
      action: "ingested-clean",
      docId: DOC,
      newText: diskT,
      activeBound: false,
    });
    // the attached doc converges to the disk text
    expect(h.doc?.getText()).toBe(diskT);
    // newText == disk ⇒ disk NOT rewritten ⇒ no echo recorded for it
    expect(h.echo.isEcho(NOTE, await sha256OfText(diskT))).toBe(false);
    // base updated, markDirty + bumpStamp(sha(newText)) called
    const rec = await h.base.load(DOC);
    expect(rec?.baseText).toBe(diskT);
    expect(await h.engineState.listDirty()).toEqual([DOC]);
    expect(h.bumps).toHaveLength(1);
    expect(h.bumps[0]).toMatchObject({ path: NOTE, docId: DOC, route: "crdt-prose" });
    expect(h.bumps[0]?.sha).toBe(await sha256OfText(diskT));
  });

  it("only-crdt (disk==base): clean, disk REWRITTEN to crdt", async () => {
    const baseT = "L1\nL2\nL3\n";
    const crdtT = "L1\nCRDT\nL3\n";
    h = await setup({ base: baseT, disk: baseT, crdt: crdtT });
    const r = await h.pipeline.onVaultWrite(NOTE);
    expect(r).toEqual<IngestResult>({
      action: "ingested-clean",
      docId: DOC,
      newText: crdtT,
      activeBound: false,
    });
    // disk rewritten to the crdt winner
    expect(decode((await h.vault.read(NOTE)) ?? new Uint8Array())).toBe(crdtT);
    // echo was recorded with sha(newText) for the write-back: the ledger holds a
    // PENDING entry that the (eventual) self-triggered fs event will consume as
    // our own echo. `isEcho` (consume-once) returns true exactly because the
    // recordWrite ran. A foreign hash is NOT matched.
    expect(h.echo.isEcho(NOTE, await sha256OfText("not-our-bytes"))).toBe(false);
    expect(h.echo.isEcho(NOTE, await sha256OfText(crdtT))).toBe(true);
    expect((await h.base.load(DOC))?.baseText).toBe(crdtT);
  });

  it("both-clean disjoint: line-merge converges doc AND disk to merged", async () => {
    const baseT = "L1\nL2\nL3\n";
    const diskT = "DISK\nL2\nL3\n";
    const crdtT = "L1\nL2\nCRDT\n";
    const mergedT = "DISK\nL2\nCRDT\n";
    h = await setup({ base: baseT, disk: diskT, crdt: crdtT });
    const r = await h.pipeline.onVaultWrite(NOTE);
    expect(r).toEqual<IngestResult>({
      action: "ingested-clean",
      docId: DOC,
      newText: mergedT,
      activeBound: false,
    });
    expect(h.doc?.getText()).toBe(mergedT);
    expect(decode((await h.vault.read(NOTE)) ?? new Uint8Array())).toBe(mergedT);
    expect((await h.base.load(DOC))?.baseText).toBe(mergedT);
  });

  it("both-unclean: conflict — CRDT wins on disk, disk side becomes the artifact", async () => {
    const baseT = "L1\nL2\nL3\n";
    const diskT = "L1\nDISK\nL3\n";
    const crdtT = "L1\nCRDT\nL3\n";
    h = await setup({ base: baseT, disk: diskT, crdt: crdtT });
    const r = await h.pipeline.onVaultWrite(NOTE);
    expect(r).toEqual<IngestResult>({
      action: "ingested-conflict",
      docId: DOC,
      winningText: crdtT,
      losingText: diskT,
      activeBound: false,
    });
    // emitConflict(path, losing=disk)
    expect(h.conflicts).toHaveLength(1);
    expect(h.conflicts[0]).toEqual({ path: NOTE, losing: diskT });
    // disk rewritten to the crdt winner; base == crdt
    expect(decode((await h.vault.read(NOTE)) ?? new Uint8Array())).toBe(crdtT);
    expect((await h.base.load(DOC))?.baseText).toBe(crdtT);
    expect(h.bumps[0]?.sha).toBe(await sha256OfText(crdtT));
  });

  it("adopt-pending (no attached doc): take disk, crdtToken stays null, edit NOT dropped", async () => {
    const baseT = "X\n";
    const diskT = "X EDITED\n";
    h = await setup({ base: baseT, disk: diskT, attach: false });
    const r = await h.pipeline.onVaultWrite(NOTE);
    expect(r).toEqual<IngestResult>({
      action: "ingested-clean",
      docId: DOC,
      newText: diskT,
      activeBound: false,
    });
    const rec = await h.base.load(DOC);
    expect(rec?.baseText).toBe(diskT); // the offline edit is preserved, NOT dropped
    expect(rec?.crdtToken).toBeNull(); // still pending — nothing attached
    expect(await h.engineState.listDirty()).toEqual([DOC]);
    // newText == disk ⇒ disk NOT rewritten
    expect(h.echo.isEcho(NOTE, await sha256OfText(diskT))).toBe(false);
  });

  it("echo.recordWrite immediately precedes writeAtomic (ordering, only-crdt rewrite)", async () => {
    const baseT = "L1\nL2\nL3\n";
    const crdtT = "L1\nCRDT\nL3\n";
    h = await setup({ base: baseT, disk: baseT, crdt: crdtT });
    // Drain the FakeVault write log up to this point (seed writes).
    h.writeLog.length = 0;
    // Patch the echo ledger to interleave its record events into the SAME log.
    const realRecord = h.echo.recordWrite.bind(h.echo);
    const orderLog: string[] = [];
    h.echo.recordWrite = (p: string, hash: string): void => {
      orderLog.push(`echo:${p}`);
      realRecord(p, hash);
    };
    h.vault.onEvent((e) => {
      if (e.path === NOTE) orderLog.push(`write:${e.path}`);
    });
    await h.pipeline.onVaultWrite(NOTE);
    // The note write must be IMMEDIATELY preceded by its echo record.
    const wi = orderLog.indexOf(`write:${NOTE}`);
    expect(wi).toBeGreaterThan(0);
    expect(orderLog[wi - 1]).toBe(`echo:${NOTE}`);
  });
});
