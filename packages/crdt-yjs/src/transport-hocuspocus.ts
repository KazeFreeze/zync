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

/** Per-doc attachment over the shared socket. */
interface HpAttachment {
  readonly provider: HocuspocusProvider;
  readonly resolveSynced: () => void;
  readonly rejectSynced: (err: Error) => void;
  settled: boolean;
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
  private readonly attachments = new Map<DocId, HpAttachment>();
  private readonly statusListeners = new Set<(s: ConnStatus) => void>();
  private closed = false;

  constructor(config: HocuspocusTransportConfig) {
    this.token = config.token;
    this.socket = new HocuspocusProviderWebsocket({
      url: config.url,
      connect: config.connect ?? true,
      onStatus: ({ status }) => {
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

    let resolveSynced!: () => void;
    let rejectSynced!: (err: Error) => void;
    const syncedPromise = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
    });

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
      settled: false,
    };
    this.attachments.set(doc.id, attachment);

    return {
      synced: () => syncedPromise,
      detach: () => {
        this.detachAttachment(doc.id);
      },
    };
  }

  private detachAttachment(id: DocId): void {
    const attachment = this.attachments.get(id);
    if (attachment === undefined) return;
    this.attachments.delete(id);
    if (!attachment.settled) {
      attachment.settled = true;
      attachment.rejectSynced(new ClosedError());
    }
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
      attachment.provider.destroy();
    }
    this.attachments.clear();
    this.socket.destroy();

    // Yield once so any synchronous destroy callbacks settle before the caller continues.
    await Promise.resolve();
  }
}
