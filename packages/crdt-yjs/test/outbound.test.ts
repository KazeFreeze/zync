import { describe, it, expect, afterEach } from "vitest";
import {
  OutboundPipeline,
  type OutboundDeps,
  IngestPipeline,
  type IngestDeps,
  type IngestResult,
  IndexDoc,
  type TreeEntry,
  EchoLedger,
  BaseStore,
  FileAuthority,
  sha256OfText,
  stampHash,
} from "@zync/core";
import { FakeVault, FakeCrdtMap, MemEngineState, InProcessBus } from "@zync/core/testing";
import type { CrdtDoc, DeviceId, DocId, IdentityPort, VaultPath, Caps } from "@zync/core";
import type { InProcessTransport } from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const CONFIG = ".obsidian";
const NOTE = path("notes/a.md");
const DOC = "doc-a" as DocId;
const DEVICE_B = "dev-b" as DeviceId;
const CAPS: Caps = { maxProseBytes: 1_000_000, configDir: CONFIG };

/**
 * Poll `predicate` every `intervalMs` until it returns true or `timeoutMs` elapses.
 * Throws a clear error on timeout so flaky assertions are immediately diagnosable.
 *
 * Replaces the old fixed-iteration `flush()` which guessed at the number of event-loop
 * turns required and failed intermittently under parallel vitest worker load.
 */
async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 2000, intervalMs = 10, label = "condition" } = opts;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timeout (${String(timeoutMs)}ms): ${label} never became true`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

const identity: IdentityPort = {
  deviceId: () => DEVICE_B,
  deviceName: () => "Device B",
};

/**
 * Two real replicas of `DOC` over an InProcessBus:
 *  - docA on transport t1 (the "remote peer" that drives edits)
 *  - docB on transport t2 (OUR device — wired to the OutboundPipeline + a FakeVault)
 * An IngestPipeline shares the SAME EchoLedger and treats docB as its attached doc,
 * so we can prove our outbound write is recognized as an echo (no re-ingest bounce).
 */
interface Harness {
  bus: InProcessBus;
  t1: InProcessTransport;
  t2: InProcessTransport;
  docA: CrdtDoc;
  docB: CrdtDoc;
  provider: YjsCrdtProvider;
  vault: FakeVault;
  echo: EchoLedger;
  base: BaseStore;
  engineState: MemEngineState;
  outbound: OutboundPipeline;
  ingest: IngestPipeline;
  ingestResults: IngestResult[];
  writeLog: VaultPath[];
}

async function setup(): Promise<Harness> {
  const provider = new YjsCrdtProvider();
  const bus = new InProcessBus();
  const t1 = bus.connect();
  const t2 = bus.connect();

  const docA = provider.createDoc(DOC);
  const docB = provider.createDoc(DOC);
  // Attach both to the bus so docA's local edits relay to docB as "remote".
  t1.attach(docA);
  t2.attach(docB);

  const vault = new FakeVault();
  const tree = new FakeCrdtMap<TreeEntry>();
  const index = new IndexDoc(tree, DEVICE_B);
  const echo = new EchoLedger();
  const base = new BaseStore(vault, CONFIG);
  const engineState = new MemEngineState();

  // Seed the index path↔doc mapping (pathOf resolves doc → path via this).
  index.setStamp(NOTE, DOC, "crdt-prose", await sha256OfText(""));

  const writeLog: VaultPath[] = [];
  vault.onEvent((e) => {
    if (e.path === NOTE) writeLog.push(e.path);
  });

  const outDeps: OutboundDeps = {
    vault,
    base,
    engineState,
    echo,
    identity,
    substrate: "yjs",
    pathOf: (d) => (d === DOC ? NOTE : undefined),
  };
  const outbound = new OutboundPipeline(outDeps);
  // Wire the outbound subscription in the harness (mirrors engine.ts bindOutbound):
  // when docB receives a "remote"-origin update, drive the reconcile directly.
  docB.onUpdate((_update, origin) => {
    if (origin === "remote") void outbound.onRemoteUpdate(docB);
  });

  // Ingest sharing the SAME echo + treating docB as the attached doc.
  const authority = new FileAuthority(NOTE);
  const ingestResults: IngestResult[] = [];
  const ingestDeps: IngestDeps = {
    vault,
    index,
    echo,
    base,
    engineState,
    caps: CAPS,
    substrate: "yjs",
    getAttachedDoc: (d) => (d === DOC ? docB : undefined),
    getAuthority: () => authority,
    newDocId: () => "minted" as DocId,
    bumpStamp: () => undefined,
    emitConflict: () => undefined,
  };
  const ingest = new IngestPipeline(ingestDeps);
  // The ingest listener: every modify event drives onVaultWrite (the real bounce path).
  vault.onEvent((e) => {
    if (e.type === "modify" || e.type === "create") {
      if (e.path !== NOTE) return;
      void ingest.onVaultWrite(e.path).then((r) => ingestResults.push(r));
    }
  });

  return {
    bus,
    t1,
    t2,
    docA,
    docB,
    provider,
    vault,
    echo,
    base,
    engineState,
    outbound,
    ingest,
    ingestResults,
    writeLog,
  };
}

describe("OutboundPipeline.onRemoteUpdate (CRDT → file)", () => {
  let h: Harness;

  afterEach(async () => {
    await h.t1.close();
    await h.t2.close();
    h.docA.destroy();
    h.docB.destroy();
  });

  it("remote update writes the file exactly once (base-before-file, synced stamp set)", async () => {
    h = await setup();

    // docA edits locally → relayed to docB as "remote" → outbound fires.
    h.docA.applyEdits([{ at: 0, delete: 0, insert: "hello" }], "local-bridge");
    // Wait deterministically for the outbound reconcile (sha256 + base.save +
    // vault.writeAtomic + setSyncedStamp) to complete instead of guessing a fixed
    // number of event-loop turns.
    await waitFor(() => h.writeLog.length >= 1, { label: "vault write for NOTE" });

    expect(h.docB.getText()).toBe("hello");
    expect(decode((await h.vault.read(NOTE)) ?? new Uint8Array())).toBe("hello");
    // Exactly ONE writeAtomic for the note path.
    expect(h.writeLog).toHaveLength(1);

    // base saved with the new text (BEFORE the file — proven by ordering test below).
    expect((await h.base.load(DOC))?.baseText).toBe("hello");
    // synced stamp's hash == sha256("hello").
    const stamp = await h.engineState.getSyncedStamp(DOC);
    expect(stamp).not.toBeNull();
    expect(stampHash(stamp ?? "")).toBe(await sha256OfText("hello"));
  });

  it("quiescence: ingest sees the write as an echo (skipped-echo), no bounce", async () => {
    h = await setup();

    h.docA.applyEdits([{ at: 0, delete: 0, insert: "hello" }], "local-bridge");
    // Wait for the outbound reconcile AND the subsequent ingest result to settle.
    // The ingest fires as a fire-and-forget after the vault write event, so we poll
    // until at least one result appears to avoid asserting on an empty array.
    await waitFor(() => h.ingestResults.length >= 1, {
      label: "ingest result for echo write",
    });

    // The ingest listener saw the modify but recognized it as our echo.
    expect(h.ingestResults).toContainEqual<IngestResult>({ action: "skipped-echo" });
    // docB unchanged; exactly one write total (no re-ingest write-back).
    expect(h.docB.getText()).toBe("hello");
    expect(h.writeLog).toHaveLength(1);
  });

  it("pipelined-echo: two distinct remote updates both recognized — no re-ingest mutation", async () => {
    h = await setup();

    // Two distinct remote updates in quick succession → two reconciles, two texts.
    h.docA.applyEdits([{ at: 0, delete: 0, insert: "hello" }], "local-bridge");
    h.docA.applyEdits([{ at: 5, delete: 0, insert: "X" }], "local-bridge");
    // Wait until all outbound reconciles AND their downstream ingest echoes have
    // settled. Two remote updates → at least 2 ingest results (one per vault write).
    await waitFor(() => h.ingestResults.length >= 2, {
      label: "ingest results for both pipelined reconciles",
    });

    const finalText = h.docB.getText();
    expect(finalText).toBe("helloX");
    // Disk equals the doc's final text.
    expect(decode((await h.vault.read(NOTE)) ?? new Uint8Array())).toBe(finalText);

    // Every ingest result is a skip (echo) — NONE ingested/mutated docB.
    expect(h.ingestResults.length).toBeGreaterThanOrEqual(2);
    for (const r of h.ingestResults) {
      expect(r.action).toBe("skipped-echo");
    }
    // The doc was never re-mutated by ingest: it still equals the CRDT truth.
    expect(h.docB.getText()).toBe(finalText);
  });

  it("ordering: base saved BEFORE the file, and echo.recordWrite IMMEDIATELY precedes writeAtomic", async () => {
    h = await setup();
    // Drain seed writes (the index/base setup wrote to the vault).
    h.writeLog.length = 0;

    // Interleave base.save, echo.recordWrite, and the note write into ONE order log.
    const order: string[] = [];
    const realSave = h.base.save.bind(h.base);
    h.base.save = async (docId, rec) => {
      order.push(`base:${docId}`);
      await realSave(docId, rec);
    };
    const realRecord = h.echo.recordWrite.bind(h.echo);
    h.echo.recordWrite = (p: string, hash: string): void => {
      order.push(`echo:${p}`);
      realRecord(p, hash);
    };
    h.vault.onEvent((e) => {
      if (e.path === NOTE) order.push(`write:${e.path}`);
    });

    // Call the reconcile directly so it is a clean single pass.
    h.docB.applyEdits([{ at: 0, delete: 0, insert: "world" }], "remote");
    await h.outbound.onRemoteUpdate(h.docB);

    const bi = order.indexOf(`base:${DOC}`);
    const wi = order.indexOf(`write:${NOTE}`);
    const ei = order.indexOf(`echo:${NOTE}`);
    expect(bi).toBeGreaterThanOrEqual(0);
    expect(wi).toBeGreaterThan(bi); // base BEFORE file
    expect(ei).toBe(wi - 1); // echo IMMEDIATELY precedes the write
  });

  it("disk already matches: skips the redundant write (no self-event), still saves base + stamp", async () => {
    h = await setup();
    // Seed disk to the exact text the doc will hold — but via an echo so ingest stays quiet.
    h.docB.applyEdits([{ at: 0, delete: 0, insert: "same" }], "remote");
    h.echo.recordWrite(NOTE, await sha256OfText("same"));
    await h.vault.writeAtomic(NOTE, new TextEncoder().encode("same"));
    h.writeLog.length = 0;

    await h.outbound.onRemoteUpdate(h.docB);

    // Disk already matched ⇒ NO new write.
    expect(h.writeLog).toHaveLength(0);
    // But base + synced stamp are still reconciled.
    expect((await h.base.load(DOC))?.baseText).toBe("same");
    const stamp = await h.engineState.getSyncedStamp(DOC);
    expect(stamp).not.toBeNull();
    expect(stampHash(stamp ?? "")).toBe(await sha256OfText("same"));
  });

  it("orphan (pathOf undefined): returns without writing, base, or stamp", async () => {
    h = await setup();
    h.docB.applyEdits([{ at: 0, delete: 0, insert: "orphan" }], "remote");
    // Force pathOf to return undefined.
    h.outbound = new OutboundPipeline({
      vault: h.vault,
      base: h.base,
      engineState: h.engineState,
      echo: h.echo,
      identity,
      substrate: "yjs",
      pathOf: () => undefined,
    });
    h.writeLog.length = 0;

    await h.outbound.onRemoteUpdate(h.docB);

    expect(h.writeLog).toHaveLength(0);
    expect(await h.engineState.getSyncedStamp(DOC)).toBeNull();
  });
});
