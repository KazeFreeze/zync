import { describe, it, expect } from "vitest";
import {
  SyncEngine,
  ArtifactNotLocalError,
  sha256OfText,
  stampHash,
  type EnginePorts,
  type EngineConfig,
  type VaultPath,
  type DeviceId,
  type DocId,
} from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeEngine(deviceId: string) {
  const bus = new InProcessBus();
  const vault = new FakeVault();
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: { deviceId: () => deviceId as DeviceId, deviceName: () => deviceId },
    engineState: new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault };
}

const NOTE = "notes/a.md" as VaultPath;
const ARTIFACT = "notes/a (conflict, dev-b, abc12345).md" as VaultPath;
const CONFLICT_ID = "conflict:notes/a.md:abc12345";

async function stageConflict(engine: SyncEngine, vault: FakeVault): Promise<void> {
  // Create the live winner note through the real ingest path so it is attached + based + stamped.
  await vault.writeAtomic(NOTE, enc.encode("WINNER\n"));
  await engine.whenIdle();
  // Stage the backup artifact on disk WITHOUT a watcher event (unbound, echo-suppressed shape).
  vault.writeSilently(ARTIFACT, enc.encode("BACKUP\n"));
  // Surface the inbox entry the way emitConflict does (path = live winner, artifactPath = backup).
  engine.inbox.add({
    id: CONFLICT_ID,
    kind: "conflict",
    path: NOTE,
    artifactPath: ARTIFACT,
    detail: `Conflicting local edit to ${NOTE} kept as ${ARTIFACT}.`,
  });
}

describe("resolveContentConflict — keep-current + guards", () => {
  it("keep-current: live note untouched, backup deleted, entry cleared", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await stageConflict(engine, vault);

    await engine.resolveContentConflict(CONFLICT_ID, "keep-current");

    const noteBytes = await vault.read(NOTE);
    expect(noteBytes).not.toBeNull();
    expect(dec.decode(noteBytes ?? new Uint8Array())).toBe("WINNER\n");
    expect(await vault.read(ARTIFACT)).toBeNull();
    expect(engine.inbox.list()).toEqual([]);
    await engine.stop();
  });

  it("unknown id is an idempotent no-op (no throw)", async () => {
    const { engine } = makeEngine("dev-a");
    await engine.start();
    await expect(engine.resolveContentConflict("nope", "keep-current")).resolves.toBeUndefined();
    await engine.stop();
  });

  it("throws on a non-content-conflict entry", async () => {
    const { engine } = makeEngine("dev-a");
    await engine.start();
    engine.inbox.add({
      id: "resurrected:x:d1",
      kind: "resurrected",
      path: NOTE,
      docId: "d1" as never,
    });
    await expect(
      engine.resolveContentConflict("resurrected:x:d1", "keep-current"),
    ).rejects.toThrow();
    await engine.stop();
  });

  it("throws ArtifactNotLocalError when the backup is not on disk", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await vault.writeAtomic(NOTE, enc.encode("WINNER\n"));
    await engine.whenIdle();
    engine.inbox.add({ id: CONFLICT_ID, kind: "conflict", path: NOTE, artifactPath: ARTIFACT });
    await expect(engine.resolveContentConflict(CONFLICT_ID, "keep-backup")).rejects.toBeInstanceOf(
      ArtifactNotLocalError,
    );
    await engine.stop();
  });

  it("keep-current is idempotent under double-invoke", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await stageConflict(engine, vault);
    await engine.resolveContentConflict(CONFLICT_ID, "keep-current");
    await expect(
      engine.resolveContentConflict(CONFLICT_ID, "keep-current"),
    ).resolves.toBeUndefined();
    expect(engine.inbox.list()).toEqual([]);
    await engine.stop();
  });

  it("throws when artifactPath equals the live path (malformed entry guard)", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await vault.writeAtomic(NOTE, enc.encode("WINNER\n"));
    await engine.whenIdle();
    // Malformed: artifactPath == path (same file)
    engine.inbox.add({
      id: CONFLICT_ID,
      kind: "conflict",
      path: NOTE,
      artifactPath: NOTE,
      detail: "malformed entry",
    });
    await expect(engine.resolveContentConflict(CONFLICT_ID, "keep-current")).rejects.toThrow(
      "artifactPath equals the live path",
    );
    await engine.stop();
  });
});

const ART_CONFLICT_ID = "conflict:notes/a.md:art99";
const ART_DOC_ID = "art-d1" as DocId;

/**
 * Stage a BOUND artifact: the artifact file exists on disk AND the index has a live
 * entry for it (as if a bootstrap seed re-bound it). The base record controls whether
 * materializedHash is present.
 */
async function stageBoundConflict(
  engine: SyncEngine,
  vault: FakeVault,
  withMaterializedHash: boolean,
): Promise<void> {
  // Create the live winner note (normal ingest path).
  await vault.writeAtomic(NOTE, enc.encode("WINNER\n"));
  await engine.whenIdle();

  // Compute a hash for the artifact bytes.
  const artBytes = enc.encode("BACKUP-BOUND\n");
  const artHash = await sha256OfText("BACKUP-BOUND\n");

  // Stage the artifact file on disk via writeSilently (no echo / watcher event).
  vault.writeSilently(ARTIFACT, artBytes);

  // BIND the artifact: give it a live index entry + a base record.
  engine.index.setStamp(ARTIFACT, ART_DOC_ID, "crdt-prose", artHash);
  await engine.base.save(ART_DOC_ID, {
    baseText: "BACKUP-BOUND\n",
    fileHash: artHash,
    crdtToken: null,
    substrate: "yjs",
    ackedText: "BACKUP-BOUND\n",
    ackedHash: artHash,
    ...(withMaterializedHash ? { materializedHash: artHash } : {}),
  });

  // Surface the inbox conflict entry.
  engine.inbox.add({
    id: ART_CONFLICT_ID,
    kind: "conflict",
    path: NOTE,
    artifactPath: ARTIFACT,
    detail: `Bound artifact conflict on ${NOTE}.`,
  });
}

describe("resolveContentConflict — keep-backup", () => {
  it("keep-backup: live note becomes the backup, backup deleted, entry cleared", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await stageConflict(engine, vault);

    await engine.resolveContentConflict(CONFLICT_ID, "keep-backup");

    expect(dec.decode((await vault.read(NOTE)) ?? new Uint8Array())).toBe("BACKUP\n");
    expect(engine.getAttachedDoc(NOTE)?.getText()).toBe("BACKUP\n");
    expect(await vault.read(ARTIFACT)).toBeNull();
    expect(engine.inbox.list()).toEqual([]);
    await engine.stop();
  });

  it("keep-backup marks the doc dirty so the adopted content is pushed/recovered", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await stageConflict(engine, vault);
    await engine.resolveContentConflict(CONFLICT_ID, "keep-backup");
    // The adopted content must be reflected by the index stamp so peers converge (pendingDocs
    // stays consistent — after a settle the doc is not wedged).
    await engine.whenIdle();
    expect(dec.decode((await vault.read(NOTE)) ?? new Uint8Array())).toBe("BACKUP\n");
    // Index tree stamp must have advanced to the backup hash.
    const noteEntry = engine.index.get(NOTE);
    const backupHash = await sha256OfText("BACKUP\n");
    expect(noteEntry === undefined ? "" : stampHash(noteEntry.stamp)).toBe(backupHash);
    // Base record must reflect the backup as both baseText and materializedHash.
    const rec = noteEntry === undefined ? null : await engine.base.load(noteEntry.docId);
    expect(rec?.baseText).toBe("BACKUP\n");
    expect(rec?.materializedHash).toBe(backupHash);
    await engine.stop();
  });

  it("keep-backup is idempotent under double-invoke", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await stageConflict(engine, vault);
    await engine.resolveContentConflict(CONFLICT_ID, "keep-backup");
    await expect(
      engine.resolveContentConflict(CONFLICT_ID, "keep-backup"),
    ).resolves.toBeUndefined();
    expect(dec.decode((await vault.read(NOTE)) ?? new Uint8Array())).toBe("BACKUP\n");
    expect(engine.inbox.list()).toEqual([]);
    await engine.stop();
  });
});

describe("resolveContentConflict — bound artifact deletion", () => {
  it("bound artifact WITH materializedHash → tombstoned + removed, entry resolved", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await stageBoundConflict(engine, vault, /* withMaterializedHash */ true);

    await engine.resolveContentConflict(ART_CONFLICT_ID, "keep-current");

    // Artifact file must be gone.
    expect(await vault.read(ARTIFACT)).toBeNull();
    // Index entry must now be a tombstone (deleted === true).
    expect(engine.index.get(ARTIFACT)?.deleted).toBe(true);
    // Inbox entry must be cleared.
    expect(engine.inbox.list()).toEqual([]);
    // Live note must be untouched.
    expect(dec.decode((await vault.read(NOTE)) ?? new Uint8Array())).toBe("WINNER\n");

    await engine.stop();
  });

  it("bound artifact WITHOUT materializedHash → file LEFT on disk, NOT tombstoned, entry resolved", async () => {
    const { engine, vault } = makeEngine("dev-a");
    await engine.start();
    await stageBoundConflict(engine, vault, /* withMaterializedHash */ false);

    await engine.resolveContentConflict(ART_CONFLICT_ID, "keep-current");

    // Artifact file must still be present (byte-safe — cannot lay unsafe tombstone).
    expect(await vault.read(ARTIFACT)).not.toBeNull();
    // Index entry must NOT be tombstoned (still live).
    expect(engine.index.get(ARTIFACT)?.deleted).not.toBe(true);
    // Inbox entry must be cleared.
    expect(engine.inbox.list()).toEqual([]);
    // Live note must be untouched.
    expect(dec.decode((await vault.read(NOTE)) ?? new Uint8Array())).toBe("WINNER\n");

    await engine.stop();
  });
});
