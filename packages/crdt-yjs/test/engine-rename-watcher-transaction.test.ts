import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, VaultEvent, VaultPath } from "@zync/core";
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
 * Phase 0b-3 — rename-as-a-TRANSACTION reproduction + regression (GPT-5.5 root cause).
 *
 * The prior Fix 2 ({@link import("./engine-rename-watcher-echo.test.ts")}) modelled an
 * IDEAL, SYNCHRONOUS, IN-ORDER watcher echo: `delete(old)` then `modify(new)`, both
 * fired synchronously right after the synthetic rename. The {@link RenameEcho}'s one-
 * shot path-keyed suppression handled exactly that shape.
 *
 * But the REAL recursive `fs.watch` (NodeFsVault) is stronger:
 *   - it fires the stat-derived `delete`/`modify` events ASYNC (after a ~20ms coalesce
 *     + an async `fs.stat`), so they land AFTER the engine's onRename re-key,
 *   - the events can be REORDERED relative to each other, and
 *   - the coalesce can collapse the two raw moves for the TARGET path into a single
 *     event that — when the stat races a transient absence — surfaces as `delete(new)`.
 *
 * The fatal case GPT-5.5 root-caused: a `delete(new)` arrives for the path the rename
 * just made LIVE. The old one-shot RenameEcho only expected a `delete(OLD)`, so it does
 * NOT suppress `delete(new)` → `onDelete` tombstones the renamed (LIVE) docId, then the
 * structural reconcile's delete concern sees a fully-tombstoned docId whose disk content
 * matches the tombstone hash and `vault.remove`s the file. NET: the renamed file is
 * materialized on NEITHER device (incl. the originator that physically had it), even
 * though the index/CRDT still answer with the continuous docId.
 *
 * {@link AsyncWatcherVault} reproduces that faithfully — deferred, reordered, and able
 * to emit `delete(new)`. Pre-transaction-fix the renamed file is lost; post-fix the
 * rename transaction quarantines ALL rename fallout (old AND new) and SETTLES the
 * invariant (old absent, new present, materializing from the doc if the watcher
 * fallout removed it), so the file survives with docId continuity on both devices.
 */

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const A_MD = path("a.md");
const B_MD = path("b.md");

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

/** A deferred macrotask tick — models the watcher's async coalesce + fs.stat. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * A {@link FakeVault} whose `rename` schedules the post-rename watcher fallout on
 * DEFERRED ticks, REORDERED, and INCLUDING a `delete(new)` — the real watcher's worst
 * case the prior synchronous WatcherVault never produced.
 *
 * The fallout shape is controlled per-instance via {@link falloutFor} so the test is
 * DETERMINISTIC (we choose the exact event sequence, not a random one). The default
 * reproduces the fatal `delete(new)` case.
 */
class AsyncWatcherVault extends FakeVault {
  /** Compute the deferred watcher fallout for a rename `from → to`. Override per test. */
  falloutFor(from: VaultPath, to: VaultPath): VaultEvent[] {
    // The fatal reordering: a `delete(new)` arrives (the coalesced target probe raced a
    // transient absence) followed by a delayed `delete(old)`. NO `modify(new)` — the
    // watcher need not emit one, and its absence is what strands the file pre-fix.
    return [
      { type: "delete", path: to },
      { type: "delete", path: from },
    ];
  }

  override async rename(from: VaultPath, to: VaultPath): Promise<void> {
    const existed = (await this.read(from)) !== null;
    await super.rename(from, to); // physical move + synthetic {type:"rename"}.
    if (!existed) return;
    const fallout = this.falloutFor(from, to);
    // Fire each on its OWN deferred tick (async + ordered as falloutFor dictates), so
    // they land well AFTER onRename's synchronous re-key — the real watcher timing.
    void (async () => {
      for (const e of fallout) {
        await tick();
        this.emitRaw(e);
      }
    })();
  }

  private emitRaw(e: VaultEvent): void {
    for (const l of this.spuriousListeners) l(e);
  }

  private readonly spuriousListeners = new Set<(e: VaultEvent) => void>();

  override onEvent(cb: (e: VaultEvent) => void): () => void {
    this.spuriousListeners.add(cb);
    const unsub = super.onEvent(cb);
    return () => {
      this.spuriousListeners.delete(cb);
      unsub();
    };
  }
}

interface Device {
  engine: SyncEngine;
  vault: AsyncWatcherVault;
  transport: InProcessTransport;
}

function makeDevice(
  bus: InProcessBus,
  deviceId: string,
  name: string,
  makeVault: () => AsyncWatcherVault,
): Device {
  const vault = makeVault();
  const transport = bus.connect();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport,
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(deviceId, name),
    engineState: new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault, transport };
}

async function readNote(d: Device, p: VaultPath): Promise<string | null> {
  const bytes = await d.vault.read(p);
  return bytes === null ? null : decode(bytes);
}

/**
 * Drive devices to a JOINT fixed point, draining the DEFERRED watcher fallout between
 * rounds (a real `setTimeout(0)` tick) so the async/reordered events are delivered and
 * the transaction's settle probe runs.
 */
async function convergeAll(...devices: Device[]): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await tick(); // deliver any pending deferred watcher fallout.
    for (const d of devices) await d.engine.waitConverged();
    await tick();
    let allClear = true;
    for (const d of devices) {
      if ((await d.engine.pendingDocs()).length !== 0) {
        allClear = false;
        break;
      }
    }
    if (allClear) return;
  }
  throw new Error("convergeAll: engines did not reach a joint fixed point");
}

describe("SyncEngine rename under ASYNC/reordered watcher fallout (rename transaction)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("renamed file materializes on BOTH devices despite a deferred, reordered delete(new)+delete(old)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A", () => new AsyncWatcherVault());
    b = makeDevice(bus, "dev-b", "Device B", () => new AsyncWatcherVault());

    await a.vault.writeAtomic(A_MD, utf8("body to carry"));
    await a.engine.start();
    await b.engine.start();
    await convergeAll(a, b);
    expect(await readNote(b, A_MD)).toBe("body to carry");
    const docIdBefore = a.engine.index.get(A_MD)?.docId;
    expect(docIdBefore).toBeDefined();

    // A renames a.md → b.md. The async watcher then fires `delete(b.md)` THEN
    // `delete(a.md)` on deferred ticks — the reordered fallout that strands the file
    // pre-fix (delete(new) tombstones the live docId → reconcile removes the file).
    await a.vault.rename(A_MD, B_MD);
    await convergeAll(a, b);

    // BOTH devices (incl. the ORIGINATOR A): live entry at the NEW path, file PRESENT
    // with the original content, OLD path absent on disk AND not live.
    for (const d of [a, b]) {
      expect(await readNote(d, B_MD)).toBe("body to carry");
      expect(await readNote(d, A_MD)).toBeNull();
      // The new-path entry is LIVE (not tombstoned), carrying the continuous docId.
      const newEntry = d.engine.index.get(B_MD);
      expect(newEntry?.deleted).not.toBe(true);
      expect(newEntry?.docId).toBe(docIdBefore);
      // Exactly one live key for the docId.
      const live = d.engine.index.liveEntries().filter(([, e]) => e.docId === docIdBefore);
      expect(live.map(([p]) => p)).toEqual([B_MD]);
    }

    // No spurious conflict / resurrection.
    expect(a.engine.inbox.list()).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("delayed delete(old) AFTER modify(new): the renamed file is not stranded", async () => {
    const bus = new InProcessBus();
    // A different reordering: modify(new) first, then a delayed delete(old) — the prior
    // RenameEcho consumed modify(new) but a LATE delete(old) racing the re-key could
    // still tombstone. Quarantining old AND new survives it.
    const makeVault = (): AsyncWatcherVault => {
      const v = new AsyncWatcherVault();
      v.falloutFor = (from, to): VaultEvent[] => [
        { type: "modify", path: to },
        { type: "delete", path: from },
      ];
      return v;
    };
    a = makeDevice(bus, "dev-a", "Device A", makeVault);
    b = makeDevice(bus, "dev-b", "Device B", makeVault);

    await a.vault.writeAtomic(A_MD, utf8("content one"));
    await a.engine.start();
    await b.engine.start();
    await convergeAll(a, b);
    const docIdBefore = a.engine.index.get(A_MD)?.docId;

    await a.vault.rename(A_MD, B_MD);
    await convergeAll(a, b);

    for (const d of [a, b]) {
      expect(await readNote(d, B_MD)).toBe("content one");
      expect(await readNote(d, A_MD)).toBeNull();
      expect(d.engine.index.get(B_MD)?.docId).toBe(docIdBefore);
      expect(d.engine.index.get(B_MD)?.deleted).not.toBe(true);
    }
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("offline edit-then-rename survives async reordered fallout (dirty not cleared)", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A", () => new AsyncWatcherVault());
    b = makeDevice(bus, "dev-b", "Device B", () => new AsyncWatcherVault());

    await a.vault.writeAtomic(A_MD, utf8("v1"));
    await a.engine.start();
    await b.engine.start();
    await convergeAll(a, b);
    const docIdBefore = a.engine.index.get(A_MD)?.docId;

    // Offline: edit a.md, then rename it to b.md — the dirty edit must survive the
    // async delete(b.md)+delete(a.md) fallout (no clearDirty of the unpushed edit).
    a.transport.goOffline();
    await a.vault.writeAtomic(A_MD, utf8("v2-edited-offline"));
    await a.engine.whenIdle();
    await a.vault.rename(A_MD, B_MD);
    await tick();
    await a.engine.whenIdle();
    await tick();
    await a.engine.whenIdle();
    expect(await readNote(a, B_MD)).toBe("v2-edited-offline");

    a.transport.goOnline();
    await convergeAll(a, b);

    for (const d of [a, b]) {
      expect(await readNote(d, B_MD)).toBe("v2-edited-offline");
      expect(await readNote(d, A_MD)).toBeNull();
      expect(d.engine.index.get(B_MD)?.docId).toBe(docIdBefore);
    }
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });
});
