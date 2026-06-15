import { describe, it, expect, afterEach } from "vitest";
import { SyncEngine, sha256OfText, type EnginePorts, type EngineConfig } from "@zync/core";
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

/**
 * Phase 0b-3 Fix 4 — `materializeLiveDiskContent` must NOT clobber a disk that is
 * AHEAD of the doc (a newer, not-yet-ingested external edit).
 *
 * The method's LEGITIMATE purpose is narrow: drive the converged CRDT content to
 * disk for a RECEIVER whose file is MISSING (resurrection/rename receiver) or is
 * STALE-BEHIND the converged doc (an old file the remote update superseded). The
 * pre-fix gate ("doc == entry.stamp AND disk != entry.stamp → write") is TRUE both
 * for a stale-behind file AND for a newer un-ingested edit, so it CLOBBERS the
 * latter — content loss (Finding D `/sync/flush`-before-ingest; the crash-device
 * revert half).
 *
 * These tests drive the private materialize path DIRECTLY (a single deterministic
 * shot) rather than through `waitConverged`: the disk-ahead repro deliberately
 * SUPPRESSES ingest (via the echo ledger) to model "disk written, watcher not yet
 * reconciled", which would (correctly) keep `waitConverged` looping forever — so a
 * one-shot call is the honest, non-flaky trigger for the materialize behaviour.
 */

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const A_MD = path("a.md");

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

/**
 * Invoke the engine's private `materializeLiveDiskContent` once. It is the unit
 * under test; the public callers (`structuralReconcile` via `index.observe` and
 * `waitConverged`) wrap it in a loop, which would mask the single-shot behaviour
 * we are asserting. Narrow typed accessor — no `any`.
 */
function materialize(engine: SyncEngine): Promise<void> {
  return (engine as unknown as { materializeLiveDiskContent: () => Promise<void> })
    .materializeLiveDiskContent()
    .then(() => undefined);
}

describe("SyncEngine.materializeLiveDiskContent — must not clobber a disk ahead of the doc (0b-3 Fix 4)", () => {
  let a: Device;

  afterEach(async () => {
    await a.engine.stop().catch(() => undefined);
  });

  it("disk AHEAD (newer un-ingested edit) is PRESERVED, not reverted to the doc content", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");

    // Converge a single-device note at V0: doc == entry.stamp == base.fileHash == V0.
    await a.vault.writeAtomic(A_MD, utf8("V0"));
    await a.engine.start();
    await a.engine.waitConverged();
    expect(await readNote(a, A_MD)).toBe("V0");

    // Write a NEWER V1 directly to disk but SUPPRESS its ingest: pre-record V1's hash
    // in the echo ledger so the watcher's modify event is treated as our own echo and
    // skipped. Result: disk == V1, doc/entry.stamp/base.fileHash all still V0 — exactly
    // the "external edit landed, watcher hasn't reconciled it yet" state.
    a.engine.echo.recordWrite(A_MD, await sha256OfText("V1"));
    await a.vault.writeAtomic(A_MD, utf8("V1"));
    await a.engine.whenIdle(); // drain the (skipped-echo) ingest.
    expect(await readNote(a, A_MD)).toBe("V1");

    // Materialize MUST NOT write the stale V0 doc over the newer V1 disk content.
    // PRE-FIX: the gate (doc==stamp && disk!=stamp) is TRUE → disk is clobbered to V0.
    await materialize(a.engine);

    expect(await readNote(a, A_MD)).toBe("V1");
  });

  it("disk BEHIND (== base.fileHash) is materialized to the converged doc content", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");

    // Converge at V0: doc == entry.stamp == base.fileHash == disk == V0.
    await a.vault.writeAtomic(A_MD, utf8("V0"));
    await a.engine.start();
    await a.engine.waitConverged();

    // Advance the attached doc + index to V1, but leave the DISK at V0 (the
    // last-reconciled base content) — the genuine stale-behind receiver: the remote
    // update converged the doc + bumped the index, yet outbound's write hasn't landed.
    // (`setStamp` fires `index.observe`, whose own structural pass may already
    // materialize; calling materialize() again is idempotent and asserts the fix
    // still WRITES for a behind file — disk == base.fileHash is the disambiguator.)
    const doc = a.engine.getAttachedDoc(A_MD);
    if (doc === undefined) throw new Error("expected attached doc for a.md");
    doc.applyEdits([{ at: doc.getText().length, delete: 0, insert: "-V1" }], "local-bridge");
    const v1Text = doc.getText();
    a.engine.index.setStamp(A_MD, doc.id, "crdt-prose", await sha256OfText(v1Text));
    await a.engine.whenIdle();

    // Disk is BEHIND (V0 == base.fileHash) → SAFE to write the converged doc content.
    await materialize(a.engine);
    expect(await readNote(a, A_MD)).toBe(v1Text);
  });

  it("disk MISSING (resurrection/rename receiver) is materialized to the converged doc content", async () => {
    const bus = new InProcessBus();
    a = makeDevice(bus, "dev-a", "Device A");

    // Converge at V0.
    await a.vault.writeAtomic(A_MD, utf8("V0"));
    await a.engine.start();
    await a.engine.waitConverged();

    // Advance the doc + index to V1, then REMOVE the disk file (bytes === null) and
    // (re)stamp the entry LIVE so the delete event does not leave a tombstone — this
    // models a receiver that holds the converged doc + a live index entry but has NO
    // file yet (the C3 resurrection-receiver case the method exists to fix). bytes ===
    // null is the unambiguous "no local file" branch the fix must keep materializing.
    const doc = a.engine.getAttachedDoc(A_MD);
    if (doc === undefined) throw new Error("expected attached doc for a.md");
    doc.applyEdits([{ at: doc.getText().length, delete: 0, insert: "-V1" }], "local-bridge");
    const v1Text = doc.getText();
    const sha = await sha256OfText(v1Text);
    // Remove the file FIRST, then (re)stamp the entry LIVE so the delete event does not
    // leave a tombstone — materialize only considers live entries.
    await a.vault.remove(A_MD);
    await a.engine.whenIdle();
    a.engine.index.setStamp(A_MD, doc.id, "crdt-prose", sha);
    await a.engine.whenIdle();

    // No local file (bytes === null) → materialize MUST write the converged content.
    await materialize(a.engine);
    expect(await readNote(a, A_MD)).toBe(v1Text);
  });
});
