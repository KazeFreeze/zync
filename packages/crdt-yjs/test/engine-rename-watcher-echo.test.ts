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
 * Phase 0b-3 Fix 2 — REPRODUCTION + REGRESSION for the real-watcher rename echo.
 *
 * The in-process structural rename test (engine-structural.test.ts, Task 5) passes
 * because {@link FakeVault.rename} emits ONLY the synthetic `{type:"rename"}` event.
 * The REAL {@link NodeFsVault} recursive `fs.watch` ALSO sees the physical move and,
 * after its ~20ms coalesce, probes the filesystem and emits a `delete(oldPath)` (old
 * is now missing) + a `modify(newPath)` (new is now present) — "always emit modify on
 * a present file, delete on a missing one". Those spurious events race the engine's
 * synthetic-rename index re-key:
 *   - `modify(newPath)` → onWrite → ingest re-processes the renamed file; if it lands
 *     before the re-key it MINTS A NEW docId (continuity broken) and re-materializes.
 *   - `delete(oldPath)` → onDelete; if it lands while oldPath is still LIVE it lays a
 *     tombstone over the docId AND `clearDirty`s it (offline-edit loss).
 *
 * {@link WatcherVault} models the real watcher by emitting those spurious events after
 * the synthetic rename. Pre-fix this corrupts the renamed doc; post-fix the engine's
 * one-shot path-keyed rename-echo suppression makes them no-ops and the file
 * materializes at the new path with docId continuity preserved.
 */

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const A_MD = path("a.md");
const B_MD = path("b.md");

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

/**
 * A {@link FakeVault} whose `rename` ALSO emits the spurious post-rename
 * `delete(old)` + `modify(new)` events the real recursive `fs.watch` produces — the
 * blind spot the plain FakeVault never exercised. Both spurious events are emitted
 * SYNCHRONOUSLY right after the synthetic rename (the worst-case race: the engine's
 * onRename has re-keyed the index synchronously, but the tracked onWrite/onDelete
 * handlers for these spurious events queue immediately behind it).
 *
 * The receiver-side hazard is covered too: the engine's structural reconcile issues
 * `vault.rename(old, new)` on the RECEIVER, which routes through this same `rename`,
 * so the receiver's own watcher echo fires identically.
 */
class WatcherVault extends FakeVault {
  override async rename(from: VaultPath, to: VaultPath): Promise<void> {
    const existed = (await this.read(from)) !== null;
    await super.rename(from, to); // physical move + synthetic {type:"rename"}.
    if (!existed) return;
    // The real recursive watcher then coalesces and probes the fs: old is gone, new
    // is present. Emit the resulting spurious events the engine must suppress.
    this.emitRaw({ type: "delete", path: from });
    this.emitRaw({ type: "modify", path: to });
  }

  /** Re-emit a raw watcher event through FakeVault's private listener set. */
  private emitRaw(e: VaultEvent): void {
    // FakeVault.onEvent pushes into a private listener set; reuse it via a write that
    // we revert is overkill — instead drive the listeners directly through onEvent's
    // captured callbacks. We keep a parallel listener set for the spurious events.
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
  vault: WatcherVault;
  transport: InProcessTransport;
}

function makeDevice(bus: InProcessBus, deviceId: string, name: string): Device {
  const vault = new WatcherVault();
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

async function convergeAll(...devices: Device[]): Promise<void> {
  for (let i = 0; i < 20; i++) {
    for (const d of devices) await d.engine.waitConverged();
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

describe("SyncEngine rename under the REAL watcher echo (0b-3 Fix 2, Finding C)", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it("renamed file materializes at the new path with docId continuity despite delete(old)+modify(new) echo", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A & B converge on `a.md`.
    await a.vault.writeAtomic(A_MD, utf8("body to carry"));
    await a.engine.start();
    await b.engine.start();
    await convergeAll(a, b);
    expect(await readNote(b, A_MD)).toBe("body to carry");
    const docIdBefore = a.engine.index.get(A_MD)?.docId;
    expect(docIdBefore).toBeDefined();

    // A renames a.md → b.md through the WATCHER vault: synthetic rename + the spurious
    // delete(a.md)+modify(b.md) the real fs.watch emits. Drive to a joint fixed point.
    await a.vault.rename(A_MD, B_MD);
    await convergeAll(a, b);

    // BOTH devices: file at the NEW path with the original content, OLD path gone.
    for (const d of [a, b]) {
      expect(await readNote(d, B_MD)).toBe("body to carry");
      expect(await readNote(d, A_MD)).toBeNull();
    }

    // docId CONTINUITY: the new path carries the SAME docId the old path had — never
    // re-minted by a spurious modify(new) ingest.
    expect(a.engine.index.get(B_MD)?.docId).toBe(docIdBefore);
    expect(b.engine.index.get(B_MD)?.docId).toBe(docIdBefore);

    // No spurious conflict artifact / resurrection / inbox entry on either side.
    const artifactsA = (await a.vault.list())
      .map((f) => f.path)
      .filter((p) => p.includes("(conflict,"));
    const artifactsB = (await b.vault.list())
      .map((f) => f.path)
      .filter((p) => p.includes("(conflict,"));
    expect(artifactsA).toEqual([]);
    expect(artifactsB).toEqual([]);
    expect(a.engine.inbox.list()).toEqual([]);
    expect(b.engine.inbox.list()).toEqual([]);

    // Exactly one live entry for the docId on both (no second docId minted at b.md).
    for (const d of [a, b]) {
      const live = d.engine.index.liveEntries().filter(([, e]) => e.docId === docIdBefore);
      expect(live.map(([p]) => p)).toEqual([B_MD]);
    }

    // No false quiescence.
    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });

  it("offline edit-then-rename in one window: the dirty edit survives the rename echo", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");
    b = makeDevice(bus, "dev-b", "Device B");

    // A & B converge on `a.md` = "v1".
    await a.vault.writeAtomic(A_MD, utf8("v1"));
    await a.engine.start();
    await b.engine.start();
    await convergeAll(a, b);
    expect(await readNote(b, A_MD)).toBe("v1");
    const docIdBefore = a.engine.index.get(A_MD)?.docId;

    // A goes offline, EDITS a.md, then RENAMES it to b.md — all in one offline window.
    // The spurious delete(a.md) must NOT clear the doc's dirty flag (its edit is
    // unpushed); the spurious modify(b.md) must NOT mint a new docId. After heal the
    // edited content must reach B at the NEW path.
    a.transport.goOffline();
    await a.vault.writeAtomic(A_MD, utf8("v2-edited-offline"));
    await a.engine.whenIdle();
    await a.vault.rename(A_MD, B_MD);
    await a.engine.whenIdle();
    expect(await readNote(a, B_MD)).toBe("v2-edited-offline");

    a.transport.goOnline();
    await convergeAll(a, b);

    // The edited content reached B at the NEW path; the offline edit was NOT lost to a
    // spurious delete(old)→clearDirty, and docId continuity held.
    for (const d of [a, b]) {
      expect(await readNote(d, B_MD)).toBe("v2-edited-offline");
      expect(await readNote(d, A_MD)).toBeNull();
    }
    expect(a.engine.index.get(B_MD)?.docId).toBe(docIdBefore);
    expect(b.engine.index.get(B_MD)?.docId).toBe(docIdBefore);

    expect(await a.engine.pendingDocs()).toEqual([]);
    expect(await b.engine.pendingDocs()).toEqual([]);
  });
});
