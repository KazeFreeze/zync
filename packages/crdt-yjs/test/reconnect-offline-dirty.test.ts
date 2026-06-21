/**
 * F1 reconnect-offline-dirty test (reconnect-offline-dirty.test.ts)
 *
 * LOAD-BEARING PROOF for the F1 reconnect backstop:
 *
 * A doc is edited while the transport is OFFLINE. At that point:
 *   - The doc is marked dirty (ingest ran, markDirty fired).
 *   - Its index-observe already fired and drained from pendingChangedPaths (the scoped
 *     pass ran, but catch-up was a no-op because transport is offline).
 *   - The doc is NOT in needsCatchUp (runCatchUp returned early, so computeCatchUpSet
 *     never ran and never enqueued the doc).
 *
 * When the transport RECONNECTS, the engine MUST re-push the offline edit via the
 * onStatus-triggered runCatchUp(new Set()) (the F1 backstop). The test does NOT call
 * waitConverged() — that would mask the backstop via its own full pass. The test awaits
 * only whenIdle() after goOnline(), which drains the tracked reconnect catch-up pass.
 *
 * NOTE: the reconnect pass uses runCatchUp(new Set()) — NOT runFullConvergencePass().
 * Passing empty openDocIds avoids falsely advancing the synced stamp of active-bound docs
 * whose CRDT edits are handled by transport resync, not by the dirty-catch-up path.
 *
 * LOAD-BEARING EXPERIMENT (must be reported):
 *   1. Remove the F1 onStatus reconnect pass from start().
 *   2. Run this test — it MUST FAIL (offline edit not re-pushed, B never gets it).
 *   3. Restore the reconnect pass — test PASSES.
 * This guards the exact data-loss gap the F1 fix closes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, VaultPath } from "@zync/core";
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

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const P = path("offline-edit.md");
const ONLINE_TEXT = "initial content\n";
const OFFLINE_EDIT = "offline edit — pushed on reconnect\n";

function identity(id: string, name: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => name };
}

interface Device {
  engine: SyncEngine;
  vault: FakeVault;
  transport: InProcessTransport;
}

function makeDevice(bus: InProcessBus, deviceId: string, name: string): Device {
  const vault = new FakeVault();
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

describe("F1 reconnect-offline-dirty backstop", () => {
  let a: Device;
  let b: Device;

  afterEach(async () => {
    await a.engine.stop();
    await b.engine.stop();
  });

  it(
    "offline edit is re-pushed on reconnect WITHOUT calling waitConverged (pure engine backstop)",
    { timeout: 30_000 },
    async () => {
      const bus = new InProcessBus();
      a = makeDevice(bus, "dev-a", "Device A");
      b = makeDevice(bus, "dev-b", "Device B");

      // ── Phase 1: online setup — create the note on A, both devices converge ────────────────
      await a.engine.start();
      await b.engine.start();

      // A creates the note while online — both devices converge on the initial content.
      await a.vault.writeAtomic(P, utf8(ONLINE_TEXT));
      // Drive convergence via waitConverged so the doc is attached on both sides.
      for (let i = 0; i < 20; i++) {
        await a.engine.waitConverged();
        await b.engine.waitConverged();
        const pa = await a.engine.pendingDocs();
        const pb = await b.engine.pendingDocs();
        if (pa.length === 0 && pb.length === 0) break;
        if (i === 19) throw new Error("setup: engines did not converge on initial content");
      }

      // Sanity: B has the initial content.
      expect(await readNote(b, P)).toBe(ONLINE_TEXT);

      // ── Phase 2: A goes offline, makes an edit ──────────────────────────────────────────────
      a.transport.goOffline();

      // A edits the note OFFLINE: the index-observe fires, pendingChangedPaths drains,
      // the scoped pass runs — but catch-up is a no-op (transport offline → runCatchUp
      // returns [] immediately). The doc is dirty but NOT in needsCatchUp.
      await a.vault.writeAtomic(P, utf8(OFFLINE_EDIT));
      await a.engine.whenIdle(); // drain the scoped pass (catch-up was a no-op)

      // Confirm: A's index has the new content stamp, but the doc is still dirty.
      const entryA = a.engine.index.get(P);
      expect(entryA).toBeDefined();

      // Confirm: needsCatchUp does NOT contain the docId (catch-up never ran offline).
      if (entryA !== undefined) {
        const needsCatchUp = a.engine.lazyAttachManager.needsCatchUpSnapshot();
        // Transport is offline, so runCatchUp returned immediately — needsCatchUp was
        // never populated by the precheck. The doc is ONLY dirty, not in needsCatchUp.
        expect(needsCatchUp.has(entryA.docId)).toBe(false);
      }

      // B still has the OLD content (A was offline when it edited).
      expect(await readNote(b, P)).toBe(ONLINE_TEXT);

      // ── Phase 3: A reconnects ───────────────────────────────────────────────────────────────
      // goOnline() fires onStatus("connected"). The F1 backstop in start() observes the
      // offline→connected transition and fires runCatchUp(new Set()) (tracked). Empty
      // openDocIds avoids forcing active-bound docs through catch-up (their CRDT edits
      // are handled by transport resync); dirty docs are still selected via isDirty().
      a.transport.goOnline();

      // Await ONLY whenIdle() — this drains the tracked reconnect catch-up but does NOT
      // call waitConverged() (which would mask the backstop via its own full pass). The
      // point is to prove the ENGINE's onStatus→runCatchUp(new Set()) does the work.
      await a.engine.whenIdle();

      // Give B time to receive and apply the update (B's reconcile loop fires from the
      // relay echo → index.observe). B's whenIdle drains that work.
      await b.engine.whenIdle();

      // ── Phase 4: assert the offline edit reached B ──────────────────────────────────────────
      // The F1 backstop (onStatus reconnect catch-up) must have re-pushed A's offline edit.
      // B's reconcile loop applied it. A's disk already has OFFLINE_EDIT; B now also has it.
      expect(await readNote(b, P)).toBe(OFFLINE_EDIT);

      // A's index stamp matches the offline edit content (was bumped by ingest offline).
      // A is no longer dirty (the reconnect catch-up cleared it).
      const pendingA = await a.engine.pendingDocs();
      expect(pendingA).toEqual([]);
    },
  );

  it(
    "backstop fires through intermediate 'connecting' status (latch guard — offline→connecting→connected)",
    { timeout: 30_000 },
    async () => {
      // LOAD-BEARING REGRESSION for 557fefc.
      //
      // The real Hocuspocus transport reconnects via:
      //   offline → connecting → connected
      // not the in-process mock's offline → connected shortcut. The old guard in 464c491
      // checked `lastStatus === "offline"` — it would see lastStatus="connecting" at the
      // "connected" event and SILENTLY NOT FIRE, stranding the offline edit.
      //
      // The 557fefc fix latches `sawOfflineSinceConnected=true` on any "offline" or
      // "unauthorized" event and checks the latch (not the immediately-prior status) at
      // "connected". The latch fires correctly for both transition shapes.
      //
      // This test MUST FAIL against the old guard (`lastStatus === "offline"`) and
      // PASS with the latch — proving it is load-bearing.
      const bus = new InProcessBus();
      a = makeDevice(bus, "dev-a", "Device A");
      b = makeDevice(bus, "dev-b", "Device B");

      await a.engine.start();
      await b.engine.start();

      // Phase 1: create and converge initial content.
      await a.vault.writeAtomic(P, utf8(ONLINE_TEXT));
      for (let i = 0; i < 20; i++) {
        await a.engine.waitConverged();
        await b.engine.waitConverged();
        const pa = await a.engine.pendingDocs();
        const pb = await b.engine.pendingDocs();
        if (pa.length === 0 && pb.length === 0) break;
        if (i === 19) throw new Error("setup: engines did not converge on initial content");
      }
      expect(await readNote(b, P)).toBe(ONLINE_TEXT);

      // Phase 2: A goes offline and makes an edit.
      a.transport.goOffline();
      await a.vault.writeAtomic(P, utf8(OFFLINE_EDIT));
      await a.engine.whenIdle(); // drain the offline scoped pass (catch-up was a no-op)

      // B still has the OLD content.
      expect(await readNote(b, P)).toBe(ONLINE_TEXT);

      // Phase 3: reconnect via offline → connecting → connected (real Hocuspocus shape).
      // signalConnecting() emits "connecting" WITHOUT marking the transport connected,
      // so the engine's latch still sees the prior offline before "connected" fires.
      a.transport.signalConnecting(); // intermediate step — the old guard breaks here
      // goOnline() emits "connected". The latch guard fires because sawOfflineSinceConnected
      // is still true (set by the earlier "offline" event, NOT cleared by "connecting").
      a.transport.goOnline();

      // Drain the reconnect catch-up WITHOUT calling waitConverged().
      await a.engine.whenIdle();
      await b.engine.whenIdle();

      // The F1 backstop must have fired despite the intermediate "connecting" status.
      expect(await readNote(b, P)).toBe(OFFLINE_EDIT);
      const pendingA = await a.engine.pendingDocs();
      expect(pendingA).toEqual([]);
    },
  );
});
