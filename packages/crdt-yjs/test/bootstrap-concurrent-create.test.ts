import { describe, it, expect, afterEach } from "vitest";
import * as Y from "yjs";
import {
  IndexDoc,
  BaseStore,
  EchoLedger,
  Inbox,
  applyBootstrap,
  orphanSweep,
  orphanRecoveryPath,
  stampHash,
  sha256OfText,
  type AttachedDoc,
  type ConnStatus,
  type CrdtDoc,
  type DeviceId,
  type DocId,
  type InboxEntry,
  type OrphanMeta,
  type Route,
  type TransportPort,
  type TreeEntry,
  type Unsubscribe,
  type VaultPath,
} from "@zync/core";
import { FakeVault, MemEngineState, InProcessBus } from "@zync/core/testing";
import { YjsCrdtProvider, YjsCrdtMap } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;

/** Exchange Yjs state between two docs (both directions) so the trees converge by LWW. */
function syncDocs(...docs: Y.Doc[]): void {
  // Two passes: gather everyone's state into each, twice, so a value that wins LWW
  // propagates to all replicas regardless of pairing order.
  for (let pass = 0; pass < 2; pass++) {
    for (const from of docs) {
      for (const to of docs) {
        if (from === to) continue;
        Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
      }
    }
  }
}

/**
 * A counting wrapper over a real {@link TransportPort} — records how many times
 * `attach` was called. The landmine guard asserts attachCount stays 0.
 */
class CountingTransport implements TransportPort {
  attachCount = 0;
  constructor(private readonly inner: TransportPort) {}
  status(): ConnStatus {
    return this.inner.status();
  }
  onStatus(cb: (s: ConnStatus) => void): Unsubscribe {
    return this.inner.onStatus(cb);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  attach(doc: CrdtDoc): AttachedDoc {
    this.attachCount += 1;
    return this.inner.attach(doc);
  }
}

const transports: TransportPort[] = [];
const yDocs: Y.Doc[] = [];
afterEach(async () => {
  await Promise.all(transports.map((t) => t.close()));
  transports.length = 0;
  for (const d of yDocs) d.destroy();
  yDocs.length = 0;
});

/** A device: its own Y.Doc tree (real YjsCrdtMap), IndexDoc, vault, base, inbox, engine-state. */
interface Device {
  id: DeviceId;
  treeDoc: Y.Doc;
  index: IndexDoc;
  vault: FakeVault;
  base: BaseStore;
  echo: EchoLedger;
  inbox: Inbox;
  inboxDoc: Y.Doc;
  engineState: MemEngineState;
}

function makeDevice(name: string): Device {
  const id = name as DeviceId;
  const treeDoc = new Y.Doc();
  yDocs.push(treeDoc);
  const tree = new YjsCrdtMap<TreeEntry>(treeDoc.getMap<TreeEntry>("tree"));
  const inboxDoc = new Y.Doc();
  yDocs.push(inboxDoc);
  const inbox = new Inbox(new YjsCrdtMap<InboxEntry>(inboxDoc.getMap<InboxEntry>("inbox")));
  const vault = new FakeVault();
  return {
    id,
    treeDoc,
    index: new IndexDoc(tree, id),
    vault,
    base: new BaseStore(vault, ".obsidian"),
    echo: new EchoLedger(),
    inbox,
    inboxDoc,
    engineState: new MemEngineState(),
  };
}

function sweepDeps(d: Device): {
  vault: FakeVault;
  echo: EchoLedger;
  index: IndexDoc;
  inbox: Inbox;
  base: BaseStore;
  substrate: string;
} {
  return {
    vault: d.vault,
    echo: d.echo,
    index: d.index,
    inbox: d.inbox,
    base: d.base,
    substrate: "yjs-v1",
  };
}

describe("doubled-content landmine: byte-identical adopt → needsAttach FALSE, single docId, zero attaches", () => {
  it("device B with byte-identical local file adopts A's docId with ZERO attach and NO second docId", async () => {
    const content = "the canonical note body\n";
    const dA = docId("ulid-A");

    const a = makeDevice("dev-a");
    const b = makeDevice("dev-b");

    // Device A (canonical PC) SEEDS "x.md": mints docId dA, stamps the tree.
    const contentHash = await sha256OfText(content);
    a.index.setStamp(path("x.md"), dA, "crdt-prose", contentHash);
    await a.vault.writeAtomic(path("x.md"), new TextEncoder().encode(content));

    // Device B has a BYTE-IDENTICAL local "x.md" but has NEVER seen the server doc.
    await b.vault.writeAtomic(path("x.md"), new TextEncoder().encode(content));

    // The trees sync (B learns A's tree entry for "x.md").
    syncDocs(a.treeDoc, b.treeDoc);

    const treeEntryB = b.index.get(path("x.md"));
    expect(treeEntryB?.docId).toBe(dA); // B sees A's docId, not a new one.

    // Build a counting transport to PROVE no attach happens during adopt.
    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);
    const transport = new CountingTransport(inner);

    // B runs applyBootstrap for "x.md" using ITS local text + the synced tree stamp.
    const localTextB = new TextDecoder().decode(
      (await b.vault.read(path("x.md"))) ?? new Uint8Array(),
    );
    const result = await applyBootstrap(
      {
        base: b.base,
        engineState: b.engineState,
        baseExists: async (id) => (await b.base.load(id)) !== null,
        substrate: "yjs-v1",
      },
      {
        path: path("x.md"),
        docId: treeEntryB?.docId ?? dA,
        localText: localTextB,
        treeStamp: treeEntryB?.stamp ?? null,
        deviceId: b.id,
      },
    );

    // THE LANDMINE GUARD.
    expect(result.decision).toBe("adopt-server");
    expect(result.needsAttach).toBe(false);

    // Zero attaches: model the engine's exact rule — attach IFF needsAttach. Since the
    // guard returns false, transport.attach is never reached → attachCount stays 0.
    if (result.needsAttach) {
      const doc = new YjsCrdtProvider().createDoc(treeEntryB?.docId ?? dA);
      transport.attach(doc);
    }
    expect(transport.attachCount).toBe(0);

    // B minted NO new docId — the doc-set has exactly ONE docId bound to "x.md".
    const docIdsForX = [a.index.get(path("x.md"))?.docId, b.index.get(path("x.md"))?.docId];
    expect(new Set(docIdsForX)).toEqual(new Set([dA]));

    // Every hash matches: local file hash == tree stamp hash == base file hash on B.
    const baseB = await b.base.load(dA);
    expect(baseB?.fileHash).toBe(contentHash);
    expect(stampHash(treeEntryB?.stamp ?? "")).toBe(contentHash);
    const syncedB = await b.engineState.getSyncedStamp(dA);
    expect(stampHash(syncedB ?? "")).toBe(contentHash);

    // Nothing marked dirty — adopt is not a local edit, so no push is owed.
    expect(await b.engineState.listDirty()).toEqual([]);
  });
});

/**
 * N devices each create "daily.md" with DISTINCT docIds + DISTINCT content; the trees
 * sync (Y.Map LWW binds "daily.md" → one winner); each device runs orphanSweep → the
 * N−1 losers are recovered to DETERMINISTIC distinct paths; ALL N contents survive;
 * every device computes the SAME recovered-path set; re-running the sweep is a no-op.
 */
async function runConcurrentCreate(deviceNames: string[]): Promise<void> {
  const devices = deviceNames.map(makeDevice);

  // Each device independently creates "daily.md" with a distinct docId + distinct content.
  const creates = devices.map((d, i) => {
    const id = docId(`ulid-${d.id}`);
    const text = `content authored by ${d.id} (#${String(i)})\n`;
    const createdTs = `2026-06-11T0${String(i)}-00-00Z`;
    return { device: d, docId: id, text, createdTs };
  });

  // Stamp each device's OWN tree with its own create, and write its own local file.
  for (const c of creates) {
    const h = await sha256OfText(c.text);
    c.device.index.setStamp(path("daily.md"), c.docId, "crdt-prose", h);
    await c.device.vault.writeAtomic(path("daily.md"), new TextEncoder().encode(c.text));
  }

  // Sync ALL trees together → Y.Map LWW binds "daily.md" to exactly one winning docId.
  syncDocs(...devices.map((d) => d.treeDoc));

  // Every device must agree on the SAME winning binding for "daily.md".
  const winners = new Set(devices.map((d) => d.index.get(path("daily.md"))?.docId));
  expect(winners.size).toBe(1);
  const winnerDocId = [...winners][0];
  expect(winnerDocId).toBeDefined();

  // The full doc-set is EVERY created docId (all contents exist as Yjs docs).
  const docSet = creates.map((c) => c.docId);

  // Build the orphan-data lookup from create-metadata (engine reads this from the doc + meta map).
  const metaByDocId = new Map<DocId, { text: string; type: Route; meta: OrphanMeta }>();
  for (const c of creates) {
    metaByDocId.set(c.docId, {
      text: c.text,
      type: "crdt-prose",
      meta: {
        createdBy: c.device.id,
        createdTs: c.createdTs,
        originalPath: path("daily.md"),
      },
    });
  }
  const orphanData = (id: DocId): { text: string; type: Route; meta: OrphanMeta } => {
    const v = metaByDocId.get(id);
    if (v === undefined) throw new Error(`no orphan data for ${id}`);
    return v;
  };
  // The sweep seam is async (the engine materializes the orphan from an awaited
  // docStore load); wrap the sync lookup so this module-level test exercises the
  // same Promise-returning shape the engine passes.
  const orphanDataAsync = (
    id: DocId,
  ): Promise<{ text: string; type: Route; meta: OrphanMeta } | null> =>
    Promise.resolve(orphanData(id));

  // The DETERMINISTIC recovered paths for the N−1 losers (everyone computes the same set).
  const expectedRecoveredPaths = creates
    .filter((c) => c.docId !== winnerDocId)
    .map((c) => orphanRecoveryPath(orphanData(c.docId).meta))
    .sort();

  // EVERY device runs the sweep independently and must recover the SAME path set.
  const recoveredPathSets: string[][] = [];
  for (const d of devices) {
    const res = await orphanSweep(sweepDeps(d), {
      index: d.index,
      docSet,
      orphanData: orphanDataAsync,
    });
    recoveredPathSets.push(res.recovered.map((r) => r.path).sort());
  }
  for (const set of recoveredPathSets) {
    expect(set).toEqual(expectedRecoveredPaths);
  }

  // ALL N contents survive: the winner stays bound at "daily.md" (its content
  // materializes via the normal attach path, not the sweep); each LOSER's content
  // lands at its deterministic recovery path on every device. Nothing is dropped.
  for (const d of devices) {
    for (const c of creates) {
      if (c.docId === winnerDocId) continue;
      const recoveredPath = orphanRecoveryPath(orphanData(c.docId).meta);
      const onDisk = await d.vault.read(recoveredPath);
      expect(onDisk).not.toBeNull();
      expect(new TextDecoder().decode(onDisk ?? new Uint8Array())).toBe(c.text);
      // The recovered binding REUSES the loser's original docId (no new create).
      expect(d.index.get(recoveredPath)?.docId).toBe(c.docId);
    }
  }

  // The total distinct docIds bound across the converged trees == N (winner + N−1 losers): nothing dropped.
  const boundDocIds = new Set<DocId>();
  for (const [, entry] of devices[0]?.index.liveEntries() ?? []) boundDocIds.add(entry.docId);
  expect(boundDocIds).toEqual(new Set(docSet));

  // IDEMPOTENT: a second sweep on every device recovers NOTHING and adds no inbox duplicates.
  for (const d of devices) {
    const before = d.inbox.list().length;
    const res2 = await orphanSweep(sweepDeps(d), {
      index: d.index,
      docSet,
      orphanData: orphanDataAsync,
    });
    expect(res2.recovered).toHaveLength(0);
    expect(d.inbox.list().length).toBe(before);
  }
}

describe("concurrent-create same path — all contents survive, deterministic recovery, idempotent", () => {
  it("2 devices", async () => {
    await runConcurrentCreate(["dev-a", "dev-b"]);
  });

  it("3 devices (NEW-3)", async () => {
    await runConcurrentCreate(["dev-a", "dev-b", "dev-c"]);
  });
});
