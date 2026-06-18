import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, sha256OfText } from "@zync/core";
import type { DeviceId, EngineConfig, EnginePorts, IdentityPort, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
  type InProcessTransport,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

/**
 * CANONICAL-LF PROSE SEMANTICS (Phase-1 M0 gate #1 — y-codemirror.next #35 +
 * hash-identity safety).
 *
 * `y-codemirror.next` (#35) corrupts CodeMirror positions when a `\r\n` lives inside the
 * Yjs doc: CM counts `\r\n` as ONE char, Yjs as TWO. The mitigation is LF-only inside Yjs.
 * But Zync's convergence is built on `stamp = sha256(text)` identity — if the CRDT side is
 * LF while disk stays CRLF then `sha256(doc.getText()) !== sha256(diskBytes)` for the SAME
 * note ⇒ perpetual non-convergence (dirty never clears, clean-settle can't fire, materialize
 * endlessly rewrites disk). So LF is the CANONICAL form EVERYWHERE in the engine, and a CRLF
 * vault file converges to LF via the EXISTING materialize machinery (a one-time churn).
 *
 * This suite is the in-process invariant guard: a prose note whose on-disk bytes contain
 * `\r\n` (and a lone `\r`) must (1) enter the CRDT as PURE LF, (2) be index-stamped at
 * `sha256(LF text)`, (3) be rewritten to LF on disk, (4) reach `pendingDocs === []` (no
 * perpetual divergence), and (5) converge to the identical LF content on a second peer.
 *
 * Deterministic: settles via engine promises only (`waitConverged`/`pendingDocs`), no sleeps.
 */

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const A_MD = path("crlf.md");

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
  transport: InProcessTransport;
  // The DURABLE ports — carried so a restart can rebuild the engine over the SAME state
  // (vault / engine-state / doc-store) while minting a fresh transport + engine.
  engineState: MemEngineState;
  docStore: FakeDocStore;
}

function makeDevice(bus: InProcessBus, deviceId: string, name: string): Device {
  const vault = new FakeVault();
  const engineState = new MemEngineState();
  const docStore = new FakeDocStore();
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore,
    clock: new FakeClock(),
    identity: identity(deviceId, name),
    engineState,
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault, transport, engineState, docStore };
}

/** Rebuild a device's engine over its DURABLE ports (vault / engine-state / doc-store) with a
 * fresh transport from the same bus — the in-process analogue of a process restart. */
function restartDevice(bus: InProcessBus, prev: Device, deviceId: string, name: string): Device {
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault: prev.vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore: prev.docStore,
    clock: new FakeClock(),
    identity: identity(deviceId, name),
    engineState: prev.engineState,
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return {
    engine: new SyncEngine(ports, config),
    vault: prev.vault,
    transport,
    engineState: prev.engineState,
    docStore: prev.docStore,
  };
}

/** Decoded on-disk text for a path (NOT canonicalized — the raw bytes), or null if absent. */
async function readDisk(d: Device, p: VaultPath): Promise<string | null> {
  const bytes = await d.vault.read(p);
  return bytes === null ? null : decode(bytes);
}

/** Drive BOTH engines to a joint fixed point. */
async function converge(a: Device, b: Device): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await a.engine.waitConverged();
    await b.engine.waitConverged();
    const pa = await a.engine.pendingDocs();
    const pb = await b.engine.pendingDocs();
    if (pa.length === 0 && pb.length === 0) return;
  }
  throw new Error("converge: two engines did not reach a joint fixed point");
}

describe("canonical-LF prose semantics (y-codemirror #35 + hash-identity)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("a CRLF (+ lone CR) prose note enters the CRDT as PURE LF and converges byte-identical", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // The note as it SHOULD be once canonicalized — pure LF.
    const LF = "line1\nline2\nline3\nlast";
    // The note as it lands on disk from a Windows editor: CRLF line endings, plus a lone
    // CR (old-Mac) embedded — BOTH must canonicalize to LF.
    const CRLF = "line1\r\nline2\r\nline3\rlast";

    // Sanity: the raw on-disk bytes really do carry CR (so this is a genuine repro, not a
    // fixture the test harness silently normalized).
    await a.vault.writeAtomic(A_MD, utf8(CRLF));
    expect(await readDisk(a, A_MD)).toContain("\r");

    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // (1) The attached CRDT doc's text is PURE LF — no CR survives into the CRDT (the #35 fix).
    const docA = a.engine.getAttachedDoc(A_MD);
    expect(docA).toBeDefined();
    expect(docA?.getText()).toBe(LF);
    expect(docA?.getText().includes("\r")).toBe(false);

    // (2) The index stamp equals sha256(LF text) — NOT sha256 of the CRLF bytes.
    const lfHash = await sha256OfText(LF);
    const crlfHash = await sha256OfText(CRLF);
    expect(lfHash).not.toBe(crlfHash);
    const entryA = a.engine.index.get(A_MD);
    expect(entryA).toBeDefined();
    expect(entryA?.stamp.startsWith(lfHash)).toBe(true);

    // (3) After convergence the on-disk bytes are LF (rewritten through the normal write path).
    const diskA = await readDisk(a, A_MD);
    expect(diskA).toBe(LF);
    expect(diskA?.includes("\r")).toBe(false);

    // (4) NO perpetual divergence — both engines reach empty pendingDocs.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);

    // (5) The second peer converges to the IDENTICAL LF content (byte-for-byte).
    const diskB = await readDisk(b, A_MD);
    expect(diskB).toBe(LF);
    expect(diskB?.includes("\r")).toBe(false);
    const docB = b.engine.getAttachedDoc(A_MD);
    expect(docB?.getText()).toBe(LF);

    // Zero conflict artifacts on either inbox — a one-time line-ending churn is not a conflict.
    expect(a.engine.inbox.list()).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);
  });

  it("an external CRLF edit to an already-attached note canonicalizes to LF (no divergence)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // Converge on a clean LF note first (doc attaches on both).
    await a.vault.writeAtomic(A_MD, utf8("alpha\nbravo"));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);

    // An external editor rewrites the note with CRLF endings.
    await a.vault.writeAtomic(A_MD, utf8("alpha\r\nbravo\r\ncharlie"));
    await converge(a, b);

    const LF = "alpha\nbravo\ncharlie";
    expect(await readDisk(a, A_MD)).toBe(LF);
    expect(await readDisk(b, A_MD)).toBe(LF);
    expect(a.engine.getAttachedDoc(A_MD)?.getText()).toBe(LF);
    expect(b.engine.getAttachedDoc(A_MD)?.getText()).toBe(LF);
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });
});

/**
 * CANONICAL-LF HOLE — the BYTE-IDENTICAL ZERO-ATTACH ADOPT-SERVER branch (review of `00f3819`).
 *
 * The canonical-LF fix rewrites disk via a raw-vs-canonical write-back diff at
 * ingest / bootstrap-seed / reconcileDirtyDoc — but the `adopt-server` (zero-attach) bootstrap
 * branch does NO disk write-back. When a device boots with a PRE-EXISTING CRLF file whose
 * CANONICAL (LF) content equals an existing LF tree stamp, `applyBootstrap` returns
 * `adopt-server` + `needsAttach:false`: it saves the base + sets the synced stamp but NEVER
 * attaches the doc nor rewrites disk. So `materializeLiveDiskContent` skips it (no attached doc),
 * `settleCleanDocs` skips it, `computeCatchUpSet` doesn't select it (synced==tree, not dirty,
 * not open) — yet `pendingDocs`'s disk-hash clause hashes the RAW CRLF bytes and compares to the
 * LF stamp → mismatch → the doc is pending FOREVER → `waitConverged` throws after 50 rounds.
 *
 * These two scenarios FAIL on `00f3819` (stuck pending / CRLF disk). They are the real-device
 * analogues of a Dropbox/git/Windows pre-populated vault (scenario 1) and a concurrent
 * offline first-boot of "the same" note (scenario 2).
 */
describe("canonical-LF hole: zero-attach adopt-server must rewrite a pre-existing CRLF file to LF", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("scenario 1: A seeds LF; B pre-populated with the SAME note as CRLF (no base) adopts → B converges to LF", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    const LF = "shared\nnote\nbody";
    const CRLF = "shared\r\nnote\r\nbody";
    expect(await sha256OfText(LF)).not.toBe(await sha256OfText(CRLF));

    // A seeds the note as PURE LF and converges first (A attaches + stamps at sha256(LF)).
    await a.vault.writeAtomic(A_MD, utf8(LF));
    await a.engine.start();
    await a.engine.waitConverged();

    // B's vault was pre-populated (Dropbox/git/Windows) with the SAME note as CRLF — and B has
    // NO base for it (never seen the server doc). Its CANONICAL (LF) content equals A's stamp,
    // so B takes the BYTE-IDENTICAL zero-attach adopt-server branch.
    await b.vault.writeAtomic(A_MD, utf8(CRLF));
    expect(await readDisk(b, A_MD)).toContain("\r");

    await b.engine.start();
    await converge(a, b);

    // No perpetual divergence — both engines reach empty pendingDocs (the hole made B stuck).
    expect(await b.engine.pendingDocs()).toEqual([]);
    expect(await a.engine.pendingDocs()).toEqual([]);

    // B's pre-existing CRLF file was rewritten to LF (the one-time canonical-LF churn).
    const diskB = await readDisk(b, A_MD);
    expect(diskB).toBe(LF);
    expect(diskB?.includes("\r")).toBe(false);

    // B's index stamp equals sha256(LF) — and matches A's.
    const lfHash = await sha256OfText(LF);
    expect(b.engine.index.get(A_MD)?.stamp.startsWith(lfHash)).toBe(true);
    expect(a.engine.index.get(A_MD)?.stamp.startsWith(lfHash)).toBe(true);

    // A one-time line-ending churn is not a conflict.
    expect(a.engine.inbox.list()).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);
  });

  it("scenario 2: a converged device whose on-disk file is externally rewritten to CRLF while stopped re-converges to LF on restart (zero-attach converge path)", async () => {
    // The literal "two devices first-boot offline with the identical CRLF note" does NOT hit
    // the zero-attach hole in this engine: concurrent offline creates each SEED their own
    // docId, then heal via the catch-up-adopt path (which ATTACHES the winner's docId on the
    // loser and materializes the LF rewrite) — confirmed separately to converge. The genuine
    // zero-attach sibling of the adopt-server hole is the `converge` bootstrap decision: a
    // device already converged on LF (base exists, synced == tree == LF) whose on-disk file is
    // rewritten to CRLF by an external tool (git autocrlf / a Windows editor) WHILE THE ENGINE
    // IS STOPPED. On restart, bootstrap sees base + the peer's LF tree stamp + a CRLF disk whose
    // CANONICAL (LF) content equals the stamp → `converge` + `needsAttach:false`. The synced
    // stamp persisted as the LF tree stamp, so catch-up does NOT select the doc, it is never
    // attached, and `materializeLiveDiskContent` / `settleCleanDocs` both skip it — yet
    // `pendingDocs`'s disk-hash clause hashes the RAW CRLF bytes → stuck pending forever.
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    const LF = "external\nrewrite\ncase";
    const CRLF = "external\r\nrewrite\r\ncase";

    // Converge on a clean LF note first: B attaches, gets a base, and synced == tree == sha256(LF).
    await a.vault.writeAtomic(A_MD, utf8(LF));
    await a.engine.start();
    await b.engine.start();
    await converge(a, b);
    expect(await readDisk(b, A_MD)).toBe(LF);

    // B stops (A stays up, holding the tree entry on the bus). An external tool rewrites B's
    // on-disk file to CRLF while B is stopped — same canonical content, raw bytes carry CR.
    await b.engine.stop();
    await b.vault.writeAtomic(A_MD, utf8(CRLF));
    expect(await readDisk(b, A_MD)).toContain("\r");

    // B restarts, REUSING its durable ports (vault/engineState/docStore) — only the transport
    // and engine are fresh. Its synced stamp + base survive (the durable-restart model).
    b = restartDevice(bus, b, "dev-b", "Device B");
    await b.engine.start();
    await converge(a, b);

    // No perpetual divergence — B re-converges (the hole left B stuck pending on CRLF disk).
    expect(await b.engine.pendingDocs()).toEqual([]);
    expect(await a.engine.pendingDocs()).toEqual([]);

    // B's externally-CRLF'd file was rewritten back to LF (the one-time canonical-LF churn).
    const diskB = await readDisk(b, A_MD);
    expect(diskB).toBe(LF);
    expect(diskB?.includes("\r")).toBe(false);

    const lfHash = await sha256OfText(LF);
    expect(b.engine.index.get(A_MD)?.stamp.startsWith(lfHash)).toBe(true);
    expect(b.engine.inbox.list()).toEqual([]);
  });
});
