import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from "@hocuspocus/provider";
import { ClosedError } from "@zync/core";
import type {
  AttachedDoc,
  ConnStatus,
  CrdtDoc,
  DocId,
  TransportPort,
  Unsubscribe,
} from "@zync/core";
import { YjsCrdtDoc } from "./crdt.js";

export interface HocuspocusTransportConfig {
  /** URL of the @hocuspocus/server relay (LAN address in 0b). */
  url: string;
  /** Token sent to the backend for authentication, if the relay requires one. */
  token?: string;
  /**
   * Pass `false` to construct WITHOUT opening a socket — used by the no-socket smoke test so the
   * adapter can be exercised offline (the live convergence run is deferred to 0b-3).
   */
  connect?: boolean;
  /**
   * Cap (ms) for the reconnect backoff. `@hocuspocus/provider` defaults to 30000, which on a
   * flapping mobile link idles through entire viable connection windows. The plugin sets ~4000
   * on mobile so an attempt is always in flight. Omit for the desktop default.
   */
  maxDelay?: number;
}

/** Map a Hocuspocus {@link WebSocketStatus} to the engine's {@link ConnStatus}. */
function toConnStatus(status: WebSocketStatus): ConnStatus {
  switch (status) {
    case WebSocketStatus.Connected:
      return "connected";
    case WebSocketStatus.Connecting:
      return "connecting";
    case WebSocketStatus.Disconnected:
      return "offline";
  }
}

/**
 * Minimal structural view of the provider's outgoing-update acknowledgement surface
 * (verified against `@hocuspocus/provider` 2.15.3 — see the {@link HocuspocusTransport}
 * acked() doc-comment). `hasUnsyncedChanges` is `unsyncedChanges > 0`, where
 * `unsyncedChanges` is incremented per local UpdateMessage and decremented when the relay's
 * SyncStep2 ack lands; the provider emits `unsyncedChanges` on every change to that counter.
 * The provider's own `EventEmitter` is loosely typed (`on(event: string, fn: Function)`), so we
 * narrow it here rather than widen our call sites with `any`.
 */
interface AckSignal {
  readonly hasUnsyncedChanges: boolean;
  on(event: "unsyncedChanges", fn: () => void): unknown;
  off(event: "unsyncedChanges", fn: () => void): unknown;
}

/** Per-doc attachment over the shared socket. */
interface HpAttachment {
  readonly provider: HocuspocusProvider;
  readonly resolveSynced: () => void;
  readonly rejectSynced: (err: Error) => void;
  /** The same promise returned by every `AttachedDoc.synced()` for this doc. */
  readonly synced: Promise<void>;
  settled: boolean;
  /**
   * In-flight `acked()` waiter rejecters for this doc — rejected en masse on close/detach so a
   * waiter never hangs past the attachment's life (mirrors the `synced()` reject pattern). A
   * waiter removes its own rejecter from this set when it resolves.
   */
  readonly ackRejecters: Set<(err: Error) => void>;
}

/**
 * Real relay adapter: per-doc multiplex over ONE shared {@link HocuspocusProviderWebsocket}.
 * Honors the 0b-2 §A offline/reconnect contract — Hocuspocus auto-reconnects and re-syncs each
 * attached provider on its own, so the engine never re-attaches; `synced()` resolves on the
 * provider's first `synced` event and rejects with {@link ClosedError} on close.
 */
export class HocuspocusTransport implements TransportPort {
  private readonly socket: HocuspocusProviderWebsocket;
  private readonly token: string | undefined;
  /**
   * Whether the shared socket should open at all. `false` keeps the adapter fully
   * offline (the no-socket smoke test + in-process offline daemon tests).
   */
  private readonly connectEnabled: boolean;
  /**
   * Whether the lazy initial connect has already been initiated. The shared socket is
   * opened EXACTLY ONCE — on the first {@link attach} — after which Hocuspocus's own
   * auto-reconnect (and any explicit `socket.connect()/disconnect()` test seam) owns the
   * connection lifecycle. Re-forcing `connect()` on every attach would undo an explicit
   * `disconnect()` (the offline lever) made before a later attach.
   */
  private connectInitiated = false;
  private readonly attachments = new Map<DocId, HpAttachment>();
  private readonly statusListeners = new Set<(s: ConnStatus) => void>();
  private closed = false;

  constructor(config: HocuspocusTransportConfig) {
    this.token = config.token;
    this.connectEnabled = config.connect ?? true;
    // LAZY CONNECT — construct the shared socket with `connect: false` ALWAYS, then
    // open it on the first {@link attach} (see below). This is load-bearing for the
    // token-auth path against a real relay: a Hocuspocus relay with `onAuthenticate`
    // closes a connection that carries no authenticated document as Unauthorized and
    // the provider sets `shouldConnect = false` ("Won't try again") — permanently
    // OFFLINE. An EAGER socket (connect at construction) hits exactly that window
    // because the daemon boots IDLE (no doc attached until `/sync/start`); the bare
    // socket connects token-less, gets rejected, and never recovers. Deferring the
    // open until the first tokened per-doc provider is attached means the relay sees
    // an authenticating document immediately and the connection survives.
    this.socket = new HocuspocusProviderWebsocket({
      url: config.url,
      connect: false,
      ...(config.maxDelay !== undefined ? { maxDelay: config.maxDelay } : {}),
      onStatus: ({ status }) => {
        // Any departure from Disconnected means the socket's connection lifecycle is now
        // owned (by our lazy connect OR an external `socket.connect()` test seam). Latch
        // it so a later attach never force-reconnects over an explicit `disconnect()`.
        if (status !== WebSocketStatus.Disconnected) this.connectInitiated = true;
        this.emitStatus(toConnStatus(status));
      },
    });
  }

  // ── status ──────────────────────────────────────────────────────────────

  status(): ConnStatus {
    // Never throws: read the shared socket's status, defaulting to offline once closed.
    if (this.closed) return "offline";
    return toConnStatus(this.socket.status);
  }

  /**
   * Force an immediate reconnect attempt, cancelling the current backoff wait (the provider's
   * `connect()` resets `shouldConnect`). No-op before the first attach (nothing to reconnect)
   * or after close. Used by the plugin on app-resume/network-online to beat Android's
   * post-throttle stale connection instead of waiting out the backoff.
   */
  kick(): void {
    if (!this.closed && this.connectInitiated) void this.socket.connect();
  }

  onStatus(cb: (s: ConnStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private emitStatus(s: ConnStatus): void {
    for (const cb of this.statusListeners) cb(s);
  }

  // ── attach / detach ───────────────────────────────────────────────────────

  attach(doc: CrdtDoc): AttachedDoc {
    if (!(doc instanceof YjsCrdtDoc)) {
      throw new Error("HocuspocusTransport requires a YjsCrdtDoc (needs the underlying Y.Doc).");
    }

    // IDEMPOTENT: if already attached, return a handle backed by the EXISTING attachment.
    // Creating a second HocuspocusProvider for the same doc would orphan the first provider,
    // leaking the Y.Doc binding and the bus subscription.
    const existing = this.attachments.get(doc.id);
    if (existing !== undefined) {
      const existingSynced = existing.synced;
      return {
        synced: () => existingSynced,
        acked: () => this.makeAcked(existing),
        detach: () => {
          this.detachAttachment(doc.id);
        },
      };
    }

    let resolveSynced!: () => void;
    let rejectSynced!: (err: Error) => void;
    const syncedPromise = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
    });

    // LAZY CONNECT (see constructor): open the shared socket on the FIRST attach so the
    // relay's first sight of us is an authenticating document — never on construction
    // (the boot-IDLE token-auth trap) and never again on later attaches (which would undo
    // an explicit `disconnect()` offline lever). After this one-shot, Hocuspocus's own
    // auto-reconnect owns the lifecycle. Skipped entirely when offline (`connectEnabled`).
    if (this.connectEnabled && !this.connectInitiated && !this.closed) {
      this.connectInitiated = true;
      void this.socket.connect();
    }

    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: doc.id,
      document: doc.yDoc,
      ...(this.token !== undefined ? { token: this.token } : {}),
      onSynced: () => {
        const a = this.attachments.get(doc.id);
        if (a !== undefined && !a.settled) {
          a.settled = true;
          a.resolveSynced();
        }
      },
      onStatus: ({ status }) => {
        this.emitStatus(toConnStatus(status));
      },
    });

    const attachment: HpAttachment = {
      provider,
      resolveSynced,
      rejectSynced,
      synced: syncedPromise,
      settled: false,
      ackRejecters: new Set<(err: Error) => void>(),
    };
    this.attachments.set(doc.id, attachment);

    return {
      synced: () => syncedPromise,
      acked: () => this.makeAcked(attachment),
      detach: () => {
        this.detachAttachment(doc.id);
      },
    };
  }

  /**
   * Build a fresh `acked()` promise for an attachment: resolves once the provider has NO
   * unsynced changes — i.e. the relay has confirmed receipt+merge of every queued local
   * update (the RECEIVED+MERGED bar; see the {@link AttachedDoc.acked} contract). Resolves
   * IMMEDIATELY if already drained; otherwise subscribes to the provider's `unsyncedChanges`
   * event and resolves the first time the count reaches zero. Rejects with {@link ClosedError}
   * on close/detach via the attachment's `ackRejecters` set.
   *
   * ACK BAR: this is RECEIVED+MERGED on the relay, NOT fsync-grade durability — that would
   * need a server-side persistence ack (deferred). The provider decrements `unsyncedChanges`
   * when the relay's SyncStep2 acknowledgement lands for the pushed update.
   *
   * A FRESH promise per call (not a cached one) so a later call after a NEW local edit waits
   * for THAT edit's ack rather than resolving on a stale earlier drain.
   */
  private makeAcked(attachment: HpAttachment): Promise<void> {
    if (this.closed) return Promise.reject(new ClosedError());

    const signal = attachment.provider as unknown as AckSignal;

    return new Promise<void>((resolve, reject) => {
      // Already drained → the relay has received everything currently queued.
      if (!signal.hasUnsyncedChanges) {
        resolve();
        return;
      }

      const onChange = (): void => {
        if (!signal.hasUnsyncedChanges) {
          signal.off("unsyncedChanges", onChange);
          attachment.ackRejecters.delete(wrappedReject);
          resolve();
        }
      };
      const wrappedReject = (err: Error): void => {
        signal.off("unsyncedChanges", onChange);
        attachment.ackRejecters.delete(wrappedReject);
        reject(err);
      };

      signal.on("unsyncedChanges", onChange);
      attachment.ackRejecters.add(wrappedReject);
    });
  }

  /** Reject (and clear) every in-flight `acked()` waiter for an attachment — close/detach. */
  private rejectAcked(attachment: HpAttachment): void {
    for (const reject of [...attachment.ackRejecters]) reject(new ClosedError());
    attachment.ackRejecters.clear();
  }

  private detachAttachment(id: DocId): void {
    const attachment = this.attachments.get(id);
    if (attachment === undefined) return;
    this.attachments.delete(id);
    if (!attachment.settled) {
      attachment.settled = true;
      attachment.rejectSynced(new ClosedError());
    }
    this.rejectAcked(attachment);
    attachment.provider.destroy();
  }

  // ── close ─────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const attachment of this.attachments.values()) {
      if (!attachment.settled) {
        attachment.settled = true;
        attachment.rejectSynced(new ClosedError());
      }
      this.rejectAcked(attachment);
      attachment.provider.destroy();
    }
    this.attachments.clear();
    this.socket.destroy();

    // Yield once so any synchronous destroy callbacks settle before the caller continues.
    await Promise.resolve();
  }
}
