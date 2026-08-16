import { describe, expect, it, vi } from "vitest";
import { YjsCrdtProvider } from "../../crdt-yjs/src/index.js";
import { IndexDoc } from "./protocol/index-doc.js";
import { sha256OfText } from "./hash.js";
import { SyncEngine, type EngineConfig, type EnginePorts } from "./engine.js";
import { INDEX_DOC_ID } from "./ports.js";
import type {
  AttachedDoc,
  ConnStatus,
  CrdtDoc,
  DeviceId,
  DocId,
  EngineStateStore,
  IndexSnapshotRecord,
  TransportPort,
  Unsubscribe,
  VaultPath,
} from "./ports.js";
import {
  FakeBlobStore,
  FakeClock,
  FakeDocStore,
  FakeVault,
  InProcessBus,
  MemEngineState,
} from "./testing/index.js";

const path = (value: string): VaultPath => value as VaultPath;
const docId = (value: string): DocId => value as DocId;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function portsFor(vault: FakeVault, transport: TransportPort): EnginePorts {
  return {
    vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: { deviceId: () => "follower" as DeviceId, deviceName: () => "Follower" },
    engineState: new MemEngineState(),
  };
}

/**
 * The snapshot methods are OPTIONAL on `EngineStateStore`, so `vi.spyOn` infers `never` and the
 * spy will not typecheck. Every real implementation (IdbEngineState, FsEngineState, MemEngineState)
 * provides them — and the engine now refuses to construct with `indexIdentity` when they are
 * missing — so narrowing here is sound rather than a convenience cast.
 */
const withSnapshots = (
  state: EngineStateStore,
): EngineStateStore & {
  getIndexSnapshot(): Promise<IndexSnapshotRecord | null>;
  setIndexSnapshot(rec: IndexSnapshotRecord): Promise<void>;
} =>
  state as EngineStateStore & {
    getIndexSnapshot(): Promise<IndexSnapshotRecord | null>;
    setIndexSnapshot(rec: IndexSnapshotRecord): Promise<void>;
  };

const config: EngineConfig = {
  configDir: ".obsidian",
  maxProseBytes: 1_000_000,
  substrate: "yjs",
  stampDebounceMs: 0,
  reconnectHealJitterMaxMs: 0,
};

/** Holds the index state back while serving canonical note docs immediately after release. */
class DelayedIndexTransport implements TransportPort {
  readonly #serverDocs = new Map<DocId, CrdtDoc>();
  #indexFollower: CrdtDoc | null = null;
  #resolveIndex: (() => void) | null = null;
  readonly #indexSynced = new Promise<void>((resolve) => {
    this.#resolveIndex = resolve;
  });

  constructor(index: CrdtDoc, note: CrdtDoc) {
    this.#serverDocs.set(index.id, index);
    this.#serverDocs.set(note.id, note);
  }

  status(): ConnStatus {
    return "connected";
  }

  onStatus(): Unsubscribe {
    return () => undefined;
  }

  attach(doc: CrdtDoc): AttachedDoc {
    if (doc.id === INDEX_DOC_ID) {
      this.#indexFollower = doc;
      return {
        synced: () => this.#indexSynced,
        acked: () => Promise.resolve(),
        detach: () => undefined,
      };
    }
    const server = this.#serverDocs.get(doc.id);
    if (server !== undefined) {
      doc.applyUpdate(server.encodeUpdateSince(doc.encodeStateVector()), "remote");
    }
    return {
      synced: () => Promise.resolve(),
      acked: () => Promise.resolve(),
      detach: () => undefined,
    };
  }

  releaseIndex(): void {
    const follower = this.#indexFollower;
    const server = this.#serverDocs.get(INDEX_DOC_ID);
    if (follower === null || server === undefined) throw new Error("index was not attached");
    follower.applyUpdate(server.encodeUpdateSince(follower.encodeStateVector()), "remote");
    this.#resolveIndex?.();
    this.#resolveIndex = null;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("SyncEngine — slow first index handshake", () => {
  it("defers a pre-populated follower with no trusted bindings and adopts the delayed relay docId", async () => {
    const provider = new YjsCrdtProvider();
    const serverIndex = provider.createDoc(INDEX_DOC_ID);
    const serverNoteId = docId("server-note");
    const noteText = "copied vault content\n";
    new IndexDoc(serverIndex.getMap("tree"), "leader" as DeviceId).setStamp(
      path("copied.md"),
      serverNoteId,
      "crdt-prose",
      await sha256OfText(noteText),
    );
    const serverNote = provider.createDoc(serverNoteId);
    serverNote.applyEdits([{ at: 0, delete: 0, insert: noteText }], "local-bridge");

    const transport = new DelayedIndexTransport(serverIndex, serverNote);
    const vault = new FakeVault();
    await vault.writeAtomic(path("copied.md"), bytes(noteText));
    const ports = portsFor(vault, transport);
    const engine = new SyncEngine(ports, { ...config, indexSyncStartBudgetMs: 5 });

    await engine.start();
    // The timeout is not evidence of absence: no competing docId may be minted before handshake.
    expect(engine.index.get(path("copied.md"))).toBeUndefined();
    expect(await ports.docStore.list()).toEqual([]);

    transport.releaseIndex();
    await engine.whenIdle();

    expect(engine.index.get(path("copied.md"))?.docId).toBe(serverNoteId);
    expect(
      (await vault.list()).map((entry) => entry.path).filter((p) => p.includes("conflict")),
    ).toEqual([]);

    await engine.stop();
    serverNote.destroy();
    serverIndex.destroy();
  });

  it("preserves immediate offline-first seeding when the relay is genuinely offline", async () => {
    const transport = new InProcessBus().connect();
    transport.goOffline();
    const vault = new FakeVault();
    await vault.writeAtomic(path("offline.md"), bytes("local-only\n"));
    const engine = new SyncEngine(portsFor(vault, transport), {
      ...config,
      indexSyncStartBudgetMs: 5,
    });

    await engine.start();

    expect(engine.index.get(path("offline.md"))?.docId).toBeDefined();
    await engine.stop();
  });
});

describe("SyncEngine tracked promise cleanup", () => {
  it("observes a rejecting tracked task without creating a derived unhandled rejection", async () => {
    const transport = new InProcessBus().connect();
    const engine = new SyncEngine(portsFor(new FakeVault(), transport), config);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const track = engine as unknown as { track(task: Promise<unknown>): void };
      track.track(Promise.reject(new Error("expected tracked rejection")));

      await engine.whenIdle();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("SyncEngine lifecycle serialization", () => {
  it("unsubscribes the vault work source before stop drains admitted work", async () => {
    const transport = new InProcessBus().connect();
    const vault = new FakeVault();
    const realOnEvent = vault.onEvent.bind(vault);
    let vaultEventsAccepted = false;
    vi.spyOn(vault, "onEvent").mockImplementation((cb) => {
      vaultEventsAccepted = true;
      const unsubscribe = realOnEvent(cb);
      return () => {
        vaultEventsAccepted = false;
        unsubscribe();
      };
    });
    const engine = new SyncEngine(portsFor(vault, transport), config);
    await engine.start();
    const realWhenIdle = engine.whenIdle.bind(engine);
    vi.spyOn(engine, "whenIdle").mockImplementation(async () => {
      expect(vaultEventsAccepted).toBe(false);
      await realWhenIdle();
    });

    await engine.stop();
  });

  it("serializes a queued stop and restart so their lifecycle bodies cannot interleave", async () => {
    const engine = new SyncEngine(portsFor(new FakeVault(), new InProcessBus().connect()), config);
    const internal = engine as unknown as {
      startNow(): Promise<void>;
      stopNow(): Promise<void>;
    };
    const order: string[] = [];
    let releaseFirstStart = (): void => undefined;
    const firstStartHeld = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    let starts = 0;
    vi.spyOn(internal, "startNow").mockImplementation(async () => {
      starts++;
      order.push(`start-${String(starts)}`);
      if (starts === 1) await firstStartHeld;
    });
    vi.spyOn(internal, "stopNow").mockImplementation(() => {
      order.push("stop");
      return Promise.resolve();
    });

    const firstStart = engine.start();
    const stop = engine.stop();
    const restart = engine.start();
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);

    releaseFirstStart();
    await Promise.all([firstStart, stop, restart]);
    expect(order).toEqual(["start-1", "stop", "start-2"]);
  });
});

describe("SyncEngine index persistence hardening", () => {
  it("fails construction loudly when index persistence is enabled without a writer", () => {
    const ports = portsFor(new FakeVault(), new InProcessBus().connect());
    const incomplete = ports.engineState as unknown as { setIndexSnapshot?: unknown };
    incomplete.setIndexSnapshot = undefined;

    expect(() => new SyncEngine(ports, { ...config, indexIdentity: "vault-a" })).toThrow(
      /requires engineState\.getIndexSnapshot and setIndexSnapshot/,
    );
  });

  it("records a rejected checkpoint so disk-full is distinguishable from success", async () => {
    const ports = portsFor(new FakeVault(), new InProcessBus().connect());
    const failure = new Error("disk full");
    vi.spyOn(withSnapshots(ports.engineState), "setIndexSnapshot").mockRejectedValue(failure);
    const engine = new SyncEngine(ports, { ...config, indexIdentity: "vault-a" });
    const internal = engine as unknown as {
      indexDoc: CrdtDoc | null;
      indexPersistInFlight: Promise<void> | null;
      persistIndexNow(): void;
    };
    internal.indexDoc = ports.crdt.createDoc(INDEX_DOC_ID);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    internal.persistIndexNow();
    await internal.indexPersistInFlight;

    expect(engine.indexPersistenceFailure()).toBe(failure);
    internal.indexDoc.destroy();
  });

  it("refuses a near-empty checkpoint over a previously substantial snapshot", async () => {
    const ports = portsFor(new FakeVault(), new InProcessBus().connect());
    const save = vi.spyOn(withSnapshots(ports.engineState), "setIndexSnapshot");
    const engine = new SyncEngine(ports, { ...config, indexIdentity: "vault-a" });
    const internal = engine as unknown as {
      indexDoc: CrdtDoc | null;
      largestIndexSnapshotBytes: number;
      indexPersistInFlight: Promise<void> | null;
      persistIndexNow(): void;
    };
    internal.indexDoc = ports.crdt.createDoc(INDEX_DOC_ID);
    internal.largestIndexSnapshotBytes = 1_000;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    internal.persistIndexNow();
    await internal.indexPersistInFlight;

    expect(save).not.toHaveBeenCalled();
    expect(engine.indexPersistenceFailure()).toBeInstanceOf(Error);
    internal.indexDoc.destroy();
  });

  it("joins a background checkpoint before the final save writes the freshest state", async () => {
    const ports = portsFor(new FakeVault(), new InProcessBus().connect());
    let releaseFirst = (): void => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots: Uint8Array[] = [];
    vi.spyOn(withSnapshots(ports.engineState), "setIndexSnapshot").mockImplementation((rec) => {
      snapshots.push(rec.snapshot);
      return snapshots.length === 1 ? firstHeld : Promise.resolve();
    });
    const engine = new SyncEngine(ports, { ...config, indexIdentity: "vault-a" });
    const internal = engine as unknown as {
      indexDoc: CrdtDoc | null;
      persistIndexNow(): void;
      persistIndexFinal(): Promise<void>;
    };
    const doc = ports.crdt.createDoc(INDEX_DOC_ID);
    internal.indexDoc = doc;
    internal.persistIndexNow();
    doc.getMap<string>("tree").set("new", "fresh");

    const final = internal.persistIndexFinal();
    await Promise.resolve();
    expect(snapshots).toHaveLength(1);
    releaseFirst();
    await final;

    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.byteLength).toBeGreaterThan(snapshots[0]?.byteLength ?? 0);
    doc.destroy();
  });
});

/**
 * A start that fails part-way has already armed timers and subscriptions. If the lifecycle jumps
 * straight to "stopped", the caller's stop() returns early and NOTHING is torn down — and the
 * plugin builds a fresh engine on retry, so the abandoned one leaks for the rest of the session.
 */
describe("SyncEngine failed start teardown", () => {
  it("tears down admission points when start() throws, so a later stop() is not a silent no-op", async () => {
    const transport = new InProcessBus().connect();
    const vault = new FakeVault();
    const realOnEvent = vault.onEvent.bind(vault);
    let vaultSubscribed = false;
    vi.spyOn(vault, "onEvent").mockImplementation((cb) => {
      vaultSubscribed = true;
      const unsubscribe = realOnEvent(cb);
      return () => {
        vaultSubscribed = false;
        unsubscribe();
      };
    });
    const engine = new SyncEngine(portsFor(vault, transport), config);
    const internal = engine as unknown as { startNow(): Promise<void> };
    const realStartNow = internal.startNow.bind(internal);
    vi.spyOn(internal, "startNow").mockImplementation(async () => {
      await realStartNow();
      throw new Error("bootstrap blew up after subscribing");
    });

    await expect(engine.start()).rejects.toThrow(/blew up/);
    // The failure must not have left the vault watcher feeding a dead engine.
    expect(vaultSubscribed).toBe(false);

    // And stop() must still be safe to call afterwards.
    await engine.stop();
  });
});

describe("SyncEngine.resumeCatchUp", () => {
  it("re-arms index catch-up and coalesces repeated already-connected resume calls", async () => {
    const transport = new InProcessBus().connect();
    const engine = new SyncEngine(portsFor(new FakeVault(), transport), config);
    await engine.start();
    await engine.whenIdle();
    expect(engine.isIndexCaughtUp()).toBe(true);

    let release: () => void = () => undefined;
    const held = new Promise<DocId[]>((resolve) => {
      release = () => {
        resolve([]);
      };
    });
    const catchUp = vi.spyOn(engine.lazyAttachManager, "runCatchUp").mockReturnValue(held);

    engine.resumeCatchUp();
    engine.resumeCatchUp();

    expect(engine.isIndexCaughtUp()).toBe(false);
    expect(catchUp).toHaveBeenCalledTimes(1);
    release();
    await engine.whenIdle();
    expect(engine.isIndexCaughtUp()).toBe(true);

    await engine.stop();
  });
});

/**
 * `isIndexSynced()` latches on the first handshake and never clears, so it answers "did we ever
 * reach the relay this session", not "am I current". Gating the mobile catch-up warning on it made
 * the warning unreachable after the first sync — it could not fire in the Android freeze→resume
 * window it was built for. These cover the difference.
 */
describe("SyncEngine.isIndexCaughtUp", () => {
  it("clears on disconnect while the session-lifetime synced latch stays set", async () => {
    const transport = new InProcessBus().connect();
    const engine = new SyncEngine(portsFor(new FakeVault(), transport), config);
    await engine.start();
    await engine.whenIdle();
    expect(engine.isIndexCaughtUp()).toBe(true);

    transport.goOffline();

    // The relay can move while we are away, so we are no longer current...
    expect(engine.isIndexCaughtUp()).toBe(false);
    // ...but we HAVE reached it this session, and readability must not regress: index-backed maps
    // stay safe to read while stale, or settings would blank out on every disconnect.
    expect(engine.isIndexSynced()).toBe(true);
    expect(engine.isIndexHydrated()).toBe(true);

    await engine.stop();
  });

  /**
   * The anti-stick guarantee. A quiet vault completes its state-vector exchange and sends NOTHING
   * back, so "no update arrived" cannot be distinguished from "not exchanged yet". Without a
   * ceiling the flag would stay false for the rest of the session on an idle vault and any UI
   * gated on it would sit on screen permanently — worse than the flicker the notice's grace period
   * exists to prevent, because a warning that never clears is one you learn to ignore.
   */
  it("re-arms itself after a reconnect even when no catch-up work runs", async () => {
    vi.useFakeTimers();
    try {
      const transport = new InProcessBus().connect();
      const engine = new SyncEngine(portsFor(new FakeVault(), transport), {
        ...config,
        indexCaughtUpFallbackMs: 50,
      });
      await engine.start();
      await engine.whenIdle();

      transport.goOffline();
      expect(engine.isIndexCaughtUp()).toBe(false);

      transport.goOnline();
      // Still false the instant the socket returns: that gap is exactly what the notice reports.
      expect(engine.isIndexCaughtUp()).toBe(false);

      await vi.advanceTimersByTimeAsync(60);
      expect(engine.isIndexCaughtUp()).toBe(true);

      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
