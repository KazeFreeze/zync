import { describe, it, expect, afterEach } from "vitest";
import {
  IndexDoc,
  LazyAttachManager,
  makeStamp,
  type AttachedDoc,
  type ConnStatus,
  type CrdtDoc,
  type DeviceId,
  type DocId,
  type DocStorePort,
  type Sha256,
  type TransportPort,
  type TreeEntry,
  type Unsubscribe,
  type VaultPath,
} from "@zync/core";
import { FakeCrdtMap, FakeDocStore, MemEngineState, InProcessBus } from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const sha = (s: string): Sha256 => s as Sha256;
const DEVICE = "dev-test" as DeviceId;

/** Tear down every transport a test mints so vitest reports no open handles. */
const transports: TransportPort[] = [];
afterEach(async () => {
  await Promise.all(transports.map((t) => t.close()));
  transports.length = 0;
});

/**
 * A counting wrapper over a real {@link TransportPort}. It records how many times
 * `attach` is called and tracks the PEAK number of attach operations whose
 * `synced()` has not yet settled — the bounded-queue invariant under test.
 *
 * `gateSynced` (optional) lets a test hold `synced()` PENDING until released, so
 * the in-flight window is observable rather than instantaneous.
 */
class CountingTransport implements TransportPort {
  attachCount = 0;
  inFlight = 0;
  peakInFlight = 0;

  constructor(
    private readonly inner: TransportPort,
    /** When provided, returns a promise that must resolve before `synced()` does. */
    private readonly gateSynced?: () => Promise<void>,
  ) {}

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
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    const attached = this.inner.attach(doc);
    const gate = this.gateSynced;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      this.inFlight -= 1;
    };
    return {
      detach: () => {
        attached.detach();
      },
      synced: async () => {
        try {
          if (gate !== undefined) await gate();
          await attached.synced();
        } finally {
          settle();
        }
      },
    };
  }
}

function buildIndex(): IndexDoc {
  return new IndexDoc(new FakeCrdtMap<TreeEntry>(), DEVICE);
}

describe("LazyAttachManager — inequality-triggered lazy attach + bounded catch-up", () => {
  it("identical vault: only stamp-mismatched docs attach; matched docs are NEVER attached", async () => {
    const index = buildIndex();
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);
    const transport = new CountingTransport(inner);

    // 100 entries. 97 are "already reconciled" (synced stamp == tree stamp).
    // 3 differ (synced stamp absent or different hash) -> exactly these must attach.
    const mismatched = new Set<string>(["note-5", "note-42", "note-77"]);
    for (let i = 0; i < 100; i++) {
      const id = docId(`note-${String(i)}`);
      const p = path(`note-${String(i)}.md`);
      // setStamp writes makeStamp(sha, DEVICE), so this is the tree stamp's value.
      const treeStamp = makeStamp(sha(`hash-${String(i)}`), DEVICE);
      index.setStamp(p, id, "crdt-prose", sha(`hash-${String(i)}`));

      if (mismatched.has(`note-${String(i)}`)) {
        if (i === 5) {
          // leave synced stamp ABSENT
        } else {
          await engineState.setSyncedStamp(id, makeStamp(sha(`OLD-${String(i)}`), DEVICE));
        }
      } else {
        // already reconciled — same hash part
        await engineState.setSyncedStamp(id, treeStamp);
      }
    }

    const set = await new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
    }).computeCatchUpSet(new Set());
    expect(set.map((s) => s.entry.docId).sort()).toEqual(
      [docId("note-42"), docId("note-5"), docId("note-77")].sort(),
    );

    const attached = await new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
    }).runCatchUp(new Set());

    // Exactly 3 attached — the zero-waste property.
    expect(attached).toHaveLength(3);
    expect(attached.sort()).toEqual([docId("note-42"), docId("note-5"), docId("note-77")].sort());
    expect(transport.attachCount).toBe(3);

    // The 97 matching docs now still have their synced stamp untouched & equal.
    for (let i = 0; i < 100; i++) {
      if (mismatched.has(`note-${String(i)}`)) continue;
      const synced = await engineState.getSyncedStamp(docId(`note-${String(i)}`));
      expect(synced).toBe(makeStamp(sha(`hash-${String(i)}`), DEVICE));
    }
    // The 3 mismatched docs are now reconciled.
    for (const m of ["note-5", "note-42", "note-77"]) {
      const synced = await engineState.getSyncedStamp(docId(m));
      expect(synced).not.toBeNull();
    }
  });

  it("concurrency capped at 6: all 50 reconcile, peak in-flight <= 6", async () => {
    const index = buildIndex();
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);

    // Gate synced() behind a macrotask so the in-flight window is observable.
    const gate = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 1));
    const transport = new CountingTransport(inner, gate);

    for (let i = 0; i < 50; i++) {
      const id = docId(`c-${String(i)}`);
      index.setStamp(path(`c-${String(i)}.md`), id, "crdt-prose", sha(`h-${String(i)}`));
      // every entry differs from its (absent) synced stamp -> all 50 attach
    }

    const attached = await new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
      concurrency: 6,
    }).runCatchUp(new Set());

    expect(attached).toHaveLength(50);
    expect(transport.attachCount).toBe(50);
    expect(transport.peakInFlight).toBeLessThanOrEqual(6);
    expect(transport.peakInFlight).toBeGreaterThan(1); // genuinely concurrent

    // All 50 reconciled.
    for (let i = 0; i < 50; i++) {
      const synced = await engineState.getSyncedStamp(docId(`c-${String(i)}`));
      expect(synced).toBe(makeStamp(sha(`h-${String(i)}`), DEVICE));
    }
  });

  it("unopened + unchanged is never attached", async () => {
    const index = buildIndex();
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);
    const transport = new CountingTransport(inner);

    const id = docId("solo");
    index.setStamp(path("solo.md"), id, "crdt-prose", sha("h"));
    // setStamp writes makeStamp(sha, DEVICE); reconcile with the SAME hash part.
    expect(index.get(path("solo.md"))?.stamp).toBe(makeStamp(sha("h"), DEVICE));
    await engineState.setSyncedStamp(id, makeStamp(sha("h"), DEVICE));

    const attached = await new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
    }).runCatchUp(new Set());

    expect(attached).toEqual([]);
    expect(transport.attachCount).toBe(0);
  });

  it("open forces attach despite equal stamp", async () => {
    const index = buildIndex();
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);
    const transport = new CountingTransport(inner);

    const id = docId("solo");
    index.setStamp(path("solo.md"), id, "crdt-prose", sha("h"));
    // setStamp writes makeStamp(sha, DEVICE); reconcile with the SAME hash part.
    expect(index.get(path("solo.md"))?.stamp).toBe(makeStamp(sha("h"), DEVICE));
    await engineState.setSyncedStamp(id, makeStamp(sha("h"), DEVICE));

    const attached = await new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
    }).runCatchUp(new Set([id]));

    expect(attached).toEqual([id]);
    expect(transport.attachCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: double-attach race (zombie bus-peer landmine)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A {@link DocStorePort} wrapper that injects artificial async latency into
 * `load`. This creates a real await window between the `getAttached` check and
 * the subsequent `transport.attach`, which is the race window the fix closes.
 */
class SlowDocStore implements DocStorePort {
  constructor(
    private readonly inner: DocStorePort,
    private readonly latencyMs: number,
  ) {}

  load(id: DocId): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(this.inner.load(id));
      }, this.latencyMs);
    });
  }

  save(id: DocId, snapshot: Uint8Array): Promise<void> {
    return this.inner.save(id, snapshot);
  }

  delete(id: DocId): Promise<void> {
    return this.inner.delete(id);
  }

  list(): Promise<DocId[]> {
    return this.inner.list();
  }
}

/**
 * A per-docId counting transport wrapper. `attachCountFor(id)` returns how many
 * times `attach` was called for that specific docId — so the regression test can
 * assert exactly-once even when the set has multiple docs.
 */
class PerDocCountingTransport implements TransportPort {
  private readonly counts = new Map<DocId, number>();

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
    const prev = this.counts.get(doc.id) ?? 0;
    this.counts.set(doc.id, prev + 1);
    return this.inner.attach(doc);
  }

  attachCountFor(id: DocId): number {
    return this.counts.get(id) ?? 0;
  }
}

describe("LazyAttachManager — double-attach race (zombie-peer regression)", () => {
  it("concurrent runCatchUp passes attach each docId EXACTLY ONCE even with slow docStore", async () => {
    const index = buildIndex();
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();

    // Inject 5 ms latency so two concurrent runCatchUp calls BOTH see
    // getAttached→undefined before either has returned from materialize.
    const slowStore = new SlowDocStore(new FakeDocStore(), 5);

    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);
    const transport = new PerDocCountingTransport(inner);

    const id = docId("race-doc");
    index.setStamp(path("race-doc.md"), id, "crdt-prose", sha("h1"));
    // synced stamp absent → doc is selected for catch-up

    // Both passes share the same manager (same attaching set).
    const manager = new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore: slowStore,
    });

    const openSet = new Set<DocId>();

    // Fire two concurrent catch-up passes. Without the reservation fix, BOTH passes
    // will see getAttached→undefined, await materialize, and call transport.attach
    // twice — stranding a zombie bus peer.
    await Promise.all([manager.runCatchUp(openSet), manager.runCatchUp(openSet)]);

    // MUST attach exactly once — the second concurrent pass must skip because the
    // first already reserved the docId.
    expect(transport.attachCountFor(id)).toBe(1);

    // The synced stamp must be recorded (the attach that DID happen must complete).
    const syncedStamp = await engineState.getSyncedStamp(id);
    expect(syncedStamp).not.toBeNull();
  });
});
