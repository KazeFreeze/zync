import { describe, it, expect, afterEach } from "vitest";
import {
  IndexDoc,
  LazyAttachManager,
  makeStamp,
  sha256OfText,
  stampHash,
  stampsEqual,
  type AttachedDoc,
  type ConnStatus,
  type CrdtDoc,
  type DeviceId,
  type DocId,
  type Sha256,
  type TransportPort,
  type TreeEntry,
  type Unsubscribe,
  type VaultPath,
} from "@zync/core";
import { FakeCrdtMap, FakeDocStore, MemEngineState, InProcessBus } from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

/**
 * REGRESSION GATE — the async last-writer latch in `runCatchUp` (0b-3).
 *
 * THE BUG: `computeCatchUpSet` snapshots `item.entry` at stamp S1. Between that
 * snapshot and the `setSyncedStamp` at the end of the pool worker there are awaits
 * (`synced()`, then `reconcileLocal(doc)`). If a NEWER index bump lands in that
 * window (a relayed remote bump, or the local conflict-resolution bump), the index
 * entry advances to S2 and the doc's CONTENT converges to S2 — but the pre-fix code
 * records `item.entry.stamp` (the STALE S1) as the synced stamp. `pendingDocs()`
 * then reports the doc pending FOREVER (tree stamp S2 ≠ synced S1) on the authoring
 * device, even though disk + index + doc text all agree on S2. The peer settles
 * fine → the asymmetric latch the live Docker run exposed.
 *
 * We force the ordering DETERMINISTICALLY (no sleeps) by mutating the IndexDoc entry
 * to S2 — and converging the attached doc's text to S2 — from inside the
 * `reconcileLocal` hook, which `runCatchUp` awaits AFTER it snapshotted S1 but BEFORE
 * it records the synced stamp. This is exactly the relayed-bump-during-the-window
 * race, reproduced in-process.
 */

const path = (s: string): VaultPath => s as VaultPath;
const docIdOf = (s: string): DocId => s as DocId;
const DEVICE = "dev-author" as DeviceId;

const transports: TransportPort[] = [];
afterEach(async () => {
  await Promise.all(transports.map((t) => t.close()));
  transports.length = 0;
});

/** Apply edits so the doc's text becomes exactly `text` (replace whole content). */
function setDocText(doc: CrdtDoc, text: string): void {
  const current = doc.getText();
  doc.applyEdits([{ at: 0, delete: current.length, insert: text }], "local-bridge");
}

describe("LazyAttachManager — stale catch-up snapshot latch (0b-3 regression)", () => {
  it("records the SYNCED content, not the stale S1 snapshot, when the index bumps to S2 mid-window", async () => {
    const tree = new FakeCrdtMap<TreeEntry>();
    const index = new IndexDoc(tree, DEVICE);
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const transport = bus.connect();
    transports.push(transport);

    const id = docIdOf("note-converge");
    const p = path("note.md");

    // S1: the entry the catch-up snapshots. Synced stamp absent → selected for catch-up.
    const shaV1 = await sha256OfText("v1");
    index.setStamp(p, id, "crdt-prose", shaV1);
    const s1 = index.get(p)?.stamp;
    expect(s1).toBe(makeStamp(shaV1, DEVICE));

    // S2: the content both devices actually converge to.
    const shaV2 = await sha256OfText("v2");

    // The mid-window mutation: fires once, the FIRST time reconcileLocal is awaited
    // (after `synced()`, before `setSyncedStamp`). It advances the index entry to S2
    // AND converges the attached doc's text to S2 — modelling a relayed remote bump
    // (+ its content) landing during the catch-up window.
    let bumped = false;
    const reconcileLocal = (doc: CrdtDoc): Promise<void> => {
      if (!bumped) {
        bumped = true;
        index.setStamp(p, id, "crdt-prose", shaV2);
        setDocText(doc, "v2");
      }
      return Promise.resolve();
    };

    const manager = new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
      reconcileLocal,
    });

    await manager.runCatchUp(new Set());

    // The index is now at S2; the doc text is "v2" (== S2's content). The synced stamp
    // MUST reflect what this device actually synced — S2's content hash — NOT the stale
    // S1 the worker snapshotted. Pre-fix this records S1 → permanently pending.
    const synced = await engineState.getSyncedStamp(id);
    expect(synced).not.toBeNull();
    expect(stampHash(synced ?? "")).toBe(shaV2);
    // And it must NOT be latched at the stale S1.
    expect(stampHash(synced ?? "")).not.toBe(shaV1);
  });

  it("a SINGLE post-bump catch-up pass converges the synced stamp to the final tree stamp", async () => {
    // Mirrors what `waitConverged` drives: after the racy pass leaves things at S2,
    // one more catch-up pass (no further bump) must record S2 — so pendingDocs reaches 0.
    const tree = new FakeCrdtMap<TreeEntry>();
    const index = new IndexDoc(tree, DEVICE);
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const transport = bus.connect();
    transports.push(transport);

    const id = docIdOf("note-converge");
    const p = path("note.md");

    const shaV1 = await sha256OfText("v1");
    index.setStamp(p, id, "crdt-prose", shaV1);
    const shaV2 = await sha256OfText("v2");

    const attached = new Map<DocId, CrdtDoc>();
    let bumped = false;
    const manager = new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
      // Track the attached doc so the second pass REUSES it (mirrors the engine).
      getAttached: (docId) => attached.get(docId),
      onAttached: (doc) => {
        attached.set(doc.id, doc);
      },
      reconcileLocal: (doc) => {
        if (!bumped) {
          bumped = true;
          index.setStamp(p, id, "crdt-prose", shaV2);
          setDocText(doc, "v2");
        }
        return Promise.resolve();
      },
    });

    // First (racy) pass, then a second settle pass with no further mutation.
    await manager.runCatchUp(new Set());
    await manager.runCatchUp(new Set());

    const synced = await engineState.getSyncedStamp(id);
    expect(stampHash(synced ?? "")).toBe(shaV2);
    // Tree stamp hash == synced stamp hash → pendingDocs would report 0.
    const treeHash = stampHash(index.get(p)?.stamp ?? "");
    expect(stampHash(synced ?? "")).toBe(treeHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Offline-edit-safety guardrail — the hazard the fix must NOT reintroduce.
// ─────────────────────────────────────────────────────────────────────────────

describe("LazyAttachManager — offline-edit safety (the fix must not falsely mark synced)", () => {
  it("does NOT clear dirty / falsely advance synced when an UNPUSHED local edit lands during the window", async () => {
    // A fresh local edit lands during the catch-up window: the doc's text is the new
    // local content, but the index stamp the catch-up snapshotted is the OLD content
    // and the new content was NOT exchanged with the relay (no peer holds it). The fix
    // must NOT clear the dirty flag here — clearing it would mean the edit is never
    // re-pushed (silent DATA LOSS). The doc stays dirty → re-pushed next cycle.
    const tree = new FakeCrdtMap<TreeEntry>();
    const index = new IndexDoc(tree, DEVICE);
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const transport = bus.connect();
    transports.push(transport);

    const id = docIdOf("note-dirty");
    const p = path("note.md");

    const shaOld = await sha256OfText("old");
    index.setStamp(p, id, "crdt-prose", shaOld);
    // Doc is DIRTY: this device owes a push of local content not yet on the relay.
    await engineState.markDirty(id);

    const manager = new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
      // Simulate a fresh local edit arriving in the window: the doc now carries content
      // that does NOT match the index stamp (the index has not been bumped to it yet),
      // i.e. an UNPUSHED edit. The fix records the doc's content as synced — but because
      // that content ≠ the index/tree stamp, the doc legitimately still owes a push, so
      // dirty must remain set.
      reconcileLocal: (doc) => {
        setDocText(doc, "fresh-unpushed-local-edit");
        return Promise.resolve();
      },
    });

    await manager.runCatchUp(new Set());

    // The unpushed edit must STILL be dirty — it was never actually exchanged with the
    // relay, so it owes a re-push. Clearing it here would be silent data loss.
    const dirty = await engineState.listDirty();
    expect(dirty).toContain(id);
  });

  it("catch-up is a NO-OP while offline (never advances synced / clears dirty)", async () => {
    const tree = new FakeCrdtMap<TreeEntry>();
    const index = new IndexDoc(tree, DEVICE);
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const transport = bus.connect();
    transports.push(transport);
    transport.goOffline();

    const id = docIdOf("note-offline");
    const p = path("note.md");
    const shaOld = await sha256OfText("old");
    index.setStamp(p, id, "crdt-prose", shaOld);
    await engineState.markDirty(id);

    const manager = new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
    });

    const attached = await manager.runCatchUp(new Set());
    expect(attached).toEqual([]);
    expect(await engineState.getSyncedStamp(id)).toBeNull();
    expect(await engineState.listDirty()).toContain(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RELAY-ACK GATE — the data-loss class (0b-3 Fix 5).
//
// `runCatchUp` advanced the synced-stamp / cleared dirty on the strength of
// `synced()` ALONE — which only proves the FIRST sync handshake, NOT that the
// post-reconcile push reached the relay. A crash in that window persists
// `dirty:[]` + advanced-stamp while the relay never got the content → silent loss.
//
// The fix gates dirty-clear / synced-advance on a per-doc relay ACK
// (`AttachedDoc.acked()` — "relay RECEIVED+MERGED my queued updates"). These tests
// drive a dirty doc through `runCatchUp` against a transport whose `acked()` is
// CONTROLLABLE: while it stays PENDING the stamp must NOT advance to the pushed
// content and dirty must STAY set; once it resolves, the stamp advances + dirty
// clears. Ordering is forced via the controllable ack promise — no sleeps.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A {@link TransportPort} wrapper whose `acked()` is held PENDING until the test
 * calls {@link AckControlledTransport.resolveAck}. `synced()` delegates to the inner
 * transport (so the handshake resolves normally); only the ACK is controllable —
 * modelling "the relay confirmed the handshake but has NOT yet confirmed receipt of
 * the queued post-reconcile push".
 */
class AckControlledTransport implements TransportPort {
  /** Per-doc ack resolvers — `resolveAck(id)` settles the held `acked()` promise. */
  private readonly ackResolvers = new Map<DocId, () => void>();
  private readonly ackPromises = new Map<DocId, Promise<void>>();

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
    const inner = this.inner.attach(doc);
    let ackPromise = this.ackPromises.get(doc.id);
    if (ackPromise === undefined) {
      ackPromise = new Promise<void>((resolve) => {
        this.ackResolvers.set(doc.id, resolve);
      });
      this.ackPromises.set(doc.id, ackPromise);
    }
    const heldAck = ackPromise;
    return {
      synced: () => inner.synced(),
      acked: () => heldAck,
      detach: () => {
        inner.detach();
      },
    };
  }

  /** Settle the held `acked()` promise for `id` (relay confirmed receipt). */
  resolveAck(id: DocId): void {
    this.ackResolvers.get(id)?.();
  }
}

describe("LazyAttachManager — relay-ack gate (no-loss crash window, 0b-3)", () => {
  it("does NOT advance synced / clear dirty while acked() is PENDING; both happen once it resolves", async () => {
    const tree = new FakeCrdtMap<TreeEntry>();
    const index = new IndexDoc(tree, DEVICE);
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);
    const transport = new AckControlledTransport(inner);

    const id = docIdOf("note-ack");
    const p = path("note.md");

    // The doc is dirty and its content == the index/tree stamp, so the ONLY thing
    // keeping it from clearing dirty + advancing synced is the relay ack. (Content
    // matches the index, so the second clearDirty gate — stamp equality — passes.)
    const shaV1 = await sha256OfText("v1");
    index.setStamp(p, id, "crdt-prose", shaV1);
    await engineState.markDirty(id);

    const attached = new Map<DocId, CrdtDoc>();
    const manager = new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
      deviceId: DEVICE,
      // Short ack bound: pass 1 deliberately holds the ack PENDING, so cap the wait so the
      // test exercises the timeout path quickly rather than paying the full production bound.
      ackTimeoutMs: 50,
      getAttached: (docId) => attached.get(docId),
      onAttached: (doc) => {
        attached.set(doc.id, doc);
      },
      // Push this device's content (== "v1") into the attached doc — the post-reconcile
      // state whose receipt the relay must confirm before we retire the obligation.
      reconcileLocal: (doc) => {
        setDocText(doc, "v1");
        return Promise.resolve();
      },
    });

    // PASS 1 — ack held PENDING. The synced-stamp must NOT advance to the pushed
    // content and dirty must STAY set (the relay has not confirmed receipt).
    await manager.runCatchUp(new Set());

    expect(await engineState.getSyncedStamp(id)).toBeNull();
    expect(await engineState.listDirty()).toContain(id);

    // Relay confirms receipt; a re-run (what waitConverged drives) now retires it.
    transport.resolveAck(id);
    await manager.runCatchUp(new Set());

    const synced = await engineState.getSyncedStamp(id);
    expect(stampHash(synced ?? "")).toBe(shaV1);
    expect(await engineState.listDirty()).not.toContain(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLEAN-SETTLE — the symmetric clean-disjoint-3-way-merge pendingDocs latch
// (0b-3 Fix 6 / Root 1C).
//
// THE BUG (confirmed by the live harness `three-way-merge` scenario 2x + a GPT-5.5
// cross-model review): after a clean disjoint 3-way merge the CONTENT converges
// PERFECTLY on BOTH devices — the attached doc's text hash == the on-disk content
// hash == the index entry's stamp hash (`/doc` shows contentSha==baseHash==tree
// sha). YET both devices latch `pendingDocs=1` FOREVER because the per-doc
// `syncedStamp` is stuck at an INTERMEDIATE merge hash that the tree stamp never
// returns to.
//
// WHY the ack-gated synced-advance in `runCatchUp` does NOT clear it: over the real
// async relay the doc converges to the final merged content via REMOTE updates that
// arrive AFTER the local push was acked at an intermediate hash. The catch-up
// worker's `setSyncedStamp` is only reached when the per-doc relay ACK resolves
// within the SAME pass — but a doc that converged via remote updates re-arms no
// fresh local-push ack, so the bounded `acked()` wait does not re-resolve and
// `runCatchUp` early-returns BEFORE re-stamping. The synced stamp stays latched at
// the intermediate hash even though doc==disk==index all agree on the final hash.
//
// THE FIX (`settleCleanDocs`): an explicit, idempotent CLEAN-SETTLE pass — for a
// live entry whose attached doc text hash == on-disk content hash == index stamp
// hash AND the transport has no unacked local changes for that doc, advance ONLY
// the per-doc `syncedStamp` to that agreed hash. It does NOT clear dirty (the push
// obligation still requires the specific dirty-push ack) and writes nothing but the
// synced stamp. `waitConverged`/the index-observe chain re-run it, so it converges
// the synced stamp to the stable agreed hash deterministically.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A {@link TransportPort} whose per-doc `acked()` is CONTROLLABLE — held PENDING by
 * default, resolved on demand. Models "the relay never re-confirms a fresh receipt
 * for a doc that converged via remote updates", which is what keeps the catch-up
 * worker's ack-gated `setSyncedStamp` from re-running. {@link MemDiskTransport.drain}
 * makes a doc's `acked()` resolve immediately (no unacked local changes — the
 * clean-settle precondition).
 */
class HeldAckTransport implements TransportPort {
  private readonly ackResolvers = new Map<DocId, () => void>();
  private readonly ackPromises = new Map<DocId, Promise<void>>();
  private readonly drained = new Set<DocId>();

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
    const inner = this.inner.attach(doc);
    return {
      synced: () => inner.synced(),
      acked: () => {
        if (this.drained.has(doc.id)) return Promise.resolve();
        let p = this.ackPromises.get(doc.id);
        if (p === undefined) {
          p = new Promise<void>((resolve) => {
            this.ackResolvers.set(doc.id, resolve);
          });
          this.ackPromises.set(doc.id, p);
        }
        return p;
      },
      detach: () => {
        inner.detach();
      },
    };
  }

  /** Mark a doc as having NO unacked local changes — `acked()` resolves immediately. */
  drain(id: DocId): void {
    this.drained.add(id);
    this.ackResolvers.get(id)?.();
  }
}

describe("LazyAttachManager — clean-settle the symmetric pendingDocs latch (0b-3 Fix 6)", () => {
  it("advances synced to the agreed hash when doc==disk==index + no unacked changes, WITHOUT clearing dirty or touching the index", async () => {
    const tree = new FakeCrdtMap<TreeEntry>();
    const index = new IndexDoc(tree, DEVICE);
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);
    const transport = new HeldAckTransport(inner);

    const id = docIdOf("note-clean");
    const p = path("multi.md");

    // FINAL converged content — index entry stamp == this content's hash.
    const finalText = "LINE-ONE edited-by-A\nstable middle line\nLINE-THREE edited-by-B";
    const finalSha = await sha256OfText(finalText);
    index.setStamp(p, id, "crdt-prose", finalSha);

    // The doc itself has converged to the final content (a freshly-materialized doc
    // we seed to the final text — the engine's reused, converged attached doc).
    const attached = new Map<DocId, CrdtDoc>();

    // INTERMEDIATE merge hash the synced stamp is latched at (never returns to it).
    const midSha = await sha256OfText("intermediate-merge-state");
    await engineState.setSyncedStamp(id, makeStamp(midSha, DEVICE));

    // The on-disk content hash for this path == the final content hash (disk converged).
    const diskHashOf = (docId: DocId): Promise<Sha256 | null> =>
      Promise.resolve(docId === id ? finalSha : null);

    const manager = new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
      deviceId: DEVICE,
      ackTimeoutMs: 50,
      getAttached: (docId) => attached.get(docId),
      onAttached: (doc) => {
        attached.set(doc.id, doc);
      },
      reconcileLocal: () => Promise.resolve(),
      diskHashOf,
    });

    // First catch-up attaches + seeds the doc to the final content (the reused doc),
    // but the held ack means the ack-gated `setSyncedStamp` does NOT re-stamp.
    await manager.runCatchUp(new Set());
    const reusedDoc = attached.get(id);
    if (reusedDoc === undefined) throw new Error("expected the reused doc to be attached");
    setDocText(reusedDoc, finalText);

    // PRE-SETTLE: the doc, disk and index ALL agree on the final hash, but the synced
    // stamp is still latched at the intermediate hash → pendingDocs would report 1.
    const before = await engineState.getSyncedStamp(id);
    expect(stampHash(before ?? "")).toBe(midSha);
    expect(stampsEqual(before, index.get(p)?.stamp ?? null)).toBe(false);

    // The relay now has no unacked local changes for this doc (it converged).
    transport.drain(id);

    // CLEAN-SETTLE: advances the synced stamp to the agreed (final) hash.
    await manager.settleCleanDocs();

    const after = await engineState.getSyncedStamp(id);
    expect(stampHash(after ?? "")).toBe(finalSha);
    // pendingDocs's `entry.stamp ≠ synced` clause now clears.
    expect(stampsEqual(after, index.get(p)?.stamp ?? null)).toBe(true);

    // It must NOT have touched the index entry.
    expect(stampHash(index.get(p)?.stamp ?? "")).toBe(finalSha);
  });

  it("does NOT settle synced for a doc whose text ≠ index (an unpushed edit), and never clears dirty", async () => {
    const tree = new FakeCrdtMap<TreeEntry>();
    const index = new IndexDoc(tree, DEVICE);
    const engineState = new MemEngineState();
    const provider = new YjsCrdtProvider();
    const docStore = new FakeDocStore();

    const bus = new InProcessBus();
    const inner = bus.connect();
    transports.push(inner);
    const transport = new HeldAckTransport(inner);

    const id = docIdOf("note-dirty-clean");
    const p = path("multi.md");

    // Index/disk record the OLD content; the doc carries a FRESH UNPUSHED edit.
    const oldSha = await sha256OfText("old-content");
    index.setStamp(p, id, "crdt-prose", oldSha);
    await engineState.markDirty(id);
    const staleSynced = makeStamp(await sha256OfText("stale-synced"), DEVICE);
    await engineState.setSyncedStamp(id, staleSynced);

    const attached = new Map<DocId, CrdtDoc>();
    // Disk still holds the OLD content (the unpushed edit is only in the CRDT).
    const diskHashOf = (docId: DocId): Promise<Sha256 | null> =>
      Promise.resolve(docId === id ? oldSha : null);

    const manager = new LazyAttachManager({
      index,
      engineState,
      transport,
      provider,
      docStore,
      deviceId: DEVICE,
      ackTimeoutMs: 50,
      getAttached: (docId) => attached.get(docId),
      onAttached: (doc) => {
        attached.set(doc.id, doc);
      },
      reconcileLocal: (doc) => {
        // The doc carries the fresh unpushed edit — NOT the indexed content.
        setDocText(doc, "fresh-unpushed-local-edit");
        return Promise.resolve();
      },
      diskHashOf,
    });

    await manager.runCatchUp(new Set());
    transport.drain(id);
    await manager.settleCleanDocs();

    // The doc text ≠ index/disk, so clean-settle must NOT advance the synced stamp to
    // the doc's (unpushed) content — that would falsely mark an unpushed edit as synced.
    const synced = await engineState.getSyncedStamp(id);
    expect(stampHash(synced ?? "")).toBe(stampHash(staleSynced));
    // And clean-settle never clears dirty — the push obligation is the ack gate's job.
    expect(await engineState.listDirty()).toContain(id);
  });
});
