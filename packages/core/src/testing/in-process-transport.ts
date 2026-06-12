import type {
  AttachedDoc,
  ConnStatus,
  CrdtDoc,
  DocId,
  TransportPort,
  Unsubscribe,
} from "../ports.js";
import { ClosedError } from "../errors.js";

/**
 * In-memory {@link TransportPort} used as the workhorse for every 0b-2 integration test.
 *
 * CORE-PURITY FIREWALL: this file lives in `packages/core/src` and MUST NOT import `yjs`
 * (or any CRDT substrate). It works ONLY through the {@link CrdtDoc} port — Yjs deltas are
 * relayed as opaque `Uint8Array`s and caught up via state-vector exchange, so no raw-update
 * queue is needed across offline/partition windows.
 *
 * The contract honored here (0b-2 §A):
 * - `status()` never throws.
 * - `attach(doc)` while offline returns immediately; `synced()` stays PENDING until the first
 *   successful state-vector exchange.
 * - On `goOnline()`/`heal(id)` an attached doc AUTO-resyncs (re-exchanges state vectors) — the
 *   caller does NOT re-attach.
 * - `close()` detaches all and rejects in-flight `synced()` promises with {@link ClosedError}.
 */

/** One attached `(transport, doc)` peer registered with the bus under a `DocId`. */
interface Peer {
  readonly transport: InProcessTransport;
  readonly doc: CrdtDoc;
}

/**
 * Shared message bus. Each {@link InProcessTransport} minted via {@link connect} shares this
 * bus, so docs of the same id attached to DIFFERENT transports relay updates to one another.
 */
export class InProcessBus {
  /** All registered peers, grouped by `DocId`. */
  private readonly peersByDoc = new Map<DocId, Set<Peer>>();

  /** Mint a new transport that shares this bus. */
  connect(): InProcessTransport {
    return new InProcessTransport(this);
  }

  register(peer: Peer): void {
    let set = this.peersByDoc.get(peer.doc.id);
    if (set === undefined) {
      set = new Set<Peer>();
      this.peersByDoc.set(peer.doc.id, set);
    }
    set.add(peer);
  }

  unregister(peer: Peer): void {
    const set = this.peersByDoc.get(peer.doc.id);
    if (set === undefined) return;
    set.delete(peer);
    if (set.size === 0) this.peersByDoc.delete(peer.doc.id);
  }

  /**
   * TEST SEAM: count the number of registered peers for a given DocId.
   * Returns 0 if there are none. Used by stop()-detach regression tests.
   */
  peerCount(id: DocId): number {
    return this.peersByDoc.get(id)?.size ?? 0;
  }

  /** Other peers of the same id as `peer` (excludes `peer` itself). */
  otherPeers(peer: Peer): Peer[] {
    const set = this.peersByDoc.get(peer.doc.id);
    if (set === undefined) return [];
    return [...set].filter((p) => p !== peer);
  }

  /**
   * Relay an update from `fromPeer` to every OTHER peer of the same id whose owning transport
   * `canExchange(id)`. Applied with origin `"remote"` so the receiver's loop-breaker does NOT
   * re-broadcast it (echo prevention).
   */
  broadcast(fromPeer: Peer, update: Uint8Array): void {
    for (const peer of this.otherPeers(fromPeer)) {
      if (!peer.transport.canExchange(peer.doc.id)) continue;
      peer.doc.applyUpdate(update, "remote");
    }
  }
}

/**
 * The complete, idempotent catch-up between two docs via state vectors. Yjs deltas relative to a
 * peer's state vector capture EVERYTHING missed, so re-running this on every reconnect is safe.
 */
function exchangeStateVectors(a: CrdtDoc, b: CrdtDoc): void {
  // Bring B up to A, then A up to B. Each delta is opaque to core.
  b.applyUpdate(a.encodeUpdateSince(b.encodeStateVector()), "remote");
  a.applyUpdate(b.encodeUpdateSince(a.encodeStateVector()), "remote");
}

/** Per-doc attachment bookkeeping owned by a transport. */
interface Attachment {
  readonly peer: Peer;
  readonly unsubscribe: Unsubscribe;
  /** Resolved after the FIRST successful state-vector exchange; rejected by `close()`. */
  readonly syncedPromise: Promise<void>;
  resolveSynced: () => void;
  rejectSynced: (err: Error) => void;
  /** True once `syncedPromise` has settled (resolved or rejected) — prevents double-settle. */
  settled: boolean;
}

export class InProcessTransport implements TransportPort {
  private readonly bus: InProcessBus;

  /** Transport-level connectivity (the socket). Default connected. */
  private connected = true;
  /** Set once `close()` runs — status pins to "offline" and attach becomes a no-op exchange. */
  private closed = false;

  /** Per-`DocId` partition set: ids the test has severed for THIS transport. */
  private readonly partitioned = new Set<DocId>();

  /** Attachments owned by this transport, keyed by `DocId`. */
  private readonly attachments = new Map<DocId, Attachment>();

  private readonly statusListeners = new Set<(s: ConnStatus) => void>();

  constructor(bus: InProcessBus) {
    this.bus = bus;
  }

  // ── status ──────────────────────────────────────────────────────────────

  status(): ConnStatus {
    // Never throws.
    if (this.closed || !this.connected) return "offline";
    return "connected";
  }

  onStatus(cb: (s: ConnStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private emitStatus(): void {
    const s = this.status();
    for (const cb of this.statusListeners) cb(s);
  }

  // ── test controls ───────────────────────────────────────────────────────

  /** Sever the whole transport (the socket goes down). Fires `onStatus`. */
  goOffline(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emitStatus();
  }

  /** Restore the transport. Auto-resyncs every attached doc that can now exchange, then fires. */
  goOnline(): void {
    if (this.connected || this.closed) return;
    this.connected = true;
    this.resyncAll();
    this.emitStatus();
  }

  /** Sever a SINGLE doc id for this transport (partial partition). */
  partition(id: DocId): void {
    this.partitioned.add(id);
  }

  /** Heal a single doc id. Auto-resyncs that doc if it can now exchange. */
  heal(id: DocId): void {
    if (!this.partitioned.delete(id)) return;
    const attachment = this.attachments.get(id);
    if (attachment !== undefined) this.resyncOne(attachment);
  }

  /** True when this transport may exchange updates for `id`: connected AND `id` not partitioned. */
  canExchange(id: DocId): boolean {
    return this.connected && !this.closed && !this.partitioned.has(id);
  }

  // ── attach / detach ───────────────────────────────────────────────────────

  attach(doc: CrdtDoc): AttachedDoc {
    // Defense-in-depth: if an attachment for this docId already exists, detach it
    // first (unsubscribe + bus.unregister the old peer) before registering the new
    // one — so even a double-attach (which the LazyAttachManager reservation
    // prevents at the application level) cannot strand a zombie bus peer.
    if (this.attachments.has(doc.id)) {
      this.detachAttachment(doc.id);
    }

    const peer: Peer = { transport: this, doc };

    // Loop-breaker: relay LOCAL updates only. A `"remote"`-origin update was applied BY the bus,
    // so re-broadcasting it would echo forever. When we cannot exchange, do nothing here — the
    // resync on reconnect/heal carries the advanced state.
    const unsubscribe = doc.onUpdate((update, origin) => {
      if (origin === "remote") return;
      if (!this.canExchange(doc.id)) return;
      this.bus.broadcast(peer, update);
    });

    let resolveSynced!: () => void;
    let rejectSynced!: (err: Error) => void;
    const syncedPromise = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
    });

    const attachment: Attachment = {
      peer,
      unsubscribe,
      syncedPromise,
      resolveSynced,
      rejectSynced,
      settled: false,
    };

    this.attachments.set(doc.id, attachment);
    this.bus.register(peer);

    // If we can exchange right now and peers exist, do the initial state-vector exchange and
    // resolve synced(). Otherwise leave it PENDING — resync on reconnect/heal settles it.
    if (this.canExchange(doc.id)) {
      this.resyncOne(attachment);
    }

    return {
      synced: () => attachment.syncedPromise,
      detach: () => {
        this.detachAttachment(doc.id);
      },
    };
  }

  private detachAttachment(id: DocId): void {
    const attachment = this.attachments.get(id);
    if (attachment === undefined) return;
    this.attachments.delete(id);
    attachment.unsubscribe();
    this.bus.unregister(attachment.peer);
    // Reject any unsettled synced() promise so detached/displaced peers do not
    // hang forever waiting for a state-vector exchange that will never come.
    // Mirrors how close() handles unsettled promises (carry-forward from Task 6).
    if (!attachment.settled) {
      attachment.settled = true;
      attachment.rejectSynced(new ClosedError("transport attachment detached before sync"));
    }
  }

  // ── resync ────────────────────────────────────────────────────────────────

  /** Re-exchange state vectors for one attachment with every peer that can also exchange, then
   * resolve a still-pending `synced()`. Idempotent — safe to call repeatedly. */
  private resyncOne(attachment: Attachment): void {
    const { peer } = attachment;
    if (!this.canExchange(peer.doc.id)) return;

    for (const other of this.bus.otherPeers(peer)) {
      if (!other.transport.canExchange(other.doc.id)) continue;
      exchangeStateVectors(peer.doc, other.doc);
    }

    // First successful exchange (even with zero peers) marks this doc synced for THIS device.
    if (!attachment.settled) {
      attachment.settled = true;
      attachment.resolveSynced();
    }
  }

  private resyncAll(): void {
    for (const attachment of this.attachments.values()) {
      this.resyncOne(attachment);
    }
  }

  // ── close ─────────────────────────────────────────────────────────────────

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.connected = false;

    for (const attachment of this.attachments.values()) {
      attachment.unsubscribe();
      this.bus.unregister(attachment.peer);
      if (!attachment.settled) {
        attachment.settled = true;
        attachment.rejectSynced(new ClosedError());
      }
    }
    this.attachments.clear();

    this.emitStatus();
    return Promise.resolve();
  }
}
