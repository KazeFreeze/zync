/**
 * relay.ts — content-opaque Hocuspocus WebSocket relay.
 *
 * CONTENT-BLIND by design: this module relays and persists raw Yjs update/
 * state bytes. It NEVER decodes a Y.Doc to text and NEVER interprets note
 * content. This property is what allows end-to-end encryption to land as a
 * transport revision (not a full rewrite) in a later phase.
 *
 * Responsibilities:
 *  - Start a Hocuspocus server on the configured port.
 *  - Authenticate via a static shared token (fallback) or per-device
 *    verifyToken predicate (authoritative when provided).
 *  - Wire snapshot persistence hooks (onLoadDocument / onStoreDocument)
 *    so a server crash/restart doesn't lose in-memory doc state.
 *  - Log doc NAMES (not content) via extension-logger.
 */

import { Hocuspocus } from "@hocuspocus/server";
import { Logger } from "@hocuspocus/extension-logger";
import { SnapshotStore, makeSnapshotHooks } from "./snapshot.js";
import { ConnectionTracker } from "./connection-tracker.js";

export interface RelayConfig {
  /** WebSocket listen port. */
  port: number;
  /** Directory for Yjs snapshot persistence. */
  snapshotDir: string;
  /** Static shared token (fallback when verifyToken is absent — harness/dev). */
  token?: string;
  /** Per-device token predicate (authoritative when provided). */
  verifyToken?: (token: string) => boolean;
  /** Device label for a token, for logging/attribution. */
  getDevice?: (token: string) => string | undefined;
}

export interface RelayHandle {
  hocuspocus: Hocuspocus;
  /**
   * Live connection state and reconnect-storm detection. Exposed so the admin console can answer
   * "is that device actually connected right now?" from the SERVER side — independently of whether
   * the device's own UI is telling the truth, which is exactly the case that matters when a phone
   * looks fine but keeps dropping its socket.
   */
  connections: ConnectionTracker;
  /** Gracefully shut down the relay (closes WS server + all connections). */
  close(): Promise<void>;
}

/**
 * Pure auth decision, extracted so it is unit-testable without Hocuspocus.
 * Uses verifyToken when provided, else compares against the static token.
 * Throws Error("unauthorized") on failure; returns the auth context `{ user }`
 * (Hocuspocus consumes this as the connection context) on success. This helper
 * has NO Hocuspocus dependency.
 */
export function authDecision(
  presentedToken: string,
  opts: {
    verifyToken?: (t: string) => boolean;
    staticToken?: string;
    getDevice?: (t: string) => string | undefined;
  },
): { user: string } {
  if (!opts.verifyToken && opts.staticToken === undefined) {
    throw new Error("relay: no auth configured (need verifyToken or staticToken)");
  }
  const ok = opts.verifyToken
    ? opts.verifyToken(presentedToken)
    : presentedToken === opts.staticToken;
  if (!ok) throw new Error("unauthorized");
  return { user: opts.getDevice?.(presentedToken) ?? "relay" };
}

export function createRelay(config: RelayConfig): RelayHandle {
  const store = new SnapshotStore(config.snapshotDir);
  const hooks = makeSnapshotHooks(store);
  const connections = new ConnectionTracker();
  // One socket serves one document connection, but key on both so a client holding several docs is
  // tracked per connection rather than collapsing into one session.
  const sessionKey = (socketId: string, documentName: string): string =>
    `${socketId}:${documentName}`;

  const hocuspocus = new Hocuspocus({
    port: config.port,

    // Debounce onStoreDocument calls so rapid edits don't hammer the disk.
    // A burst of updates will be persisted at most every 2 s (debounce)
    // but guaranteed within 10 s (maxDebounce).
    debounce: 2000,
    maxDebounce: 10000,

    extensions: [new Logger()],

    // Auth is per-device tokens (see token-registry.ts). Transport encryption is
    // provided by the deployment (Tailscale/WireGuard); see deploy/.
    async onAuthenticate({ token, documentName, socketId }) {
      const ctx = authDecision(token, {
        ...(config.verifyToken !== undefined ? { verifyToken: config.verifyToken } : {}),
        ...(config.token !== undefined ? { staticToken: config.token } : {}),
        ...(config.getDevice !== undefined ? { getDevice: config.getDevice } : {}),
      });
      connections.connect(sessionKey(socketId, documentName), ctx.user, documentName);
      console.log(`[zync-relay] +conn ${ctx.user} ${documentName}`);
      return ctx;
    },

    // Disconnect logging with SESSION DURATION. Without it a reconnect storm - a socket that opens
    // and closes every few seconds, so the initial sync never completes - was invisible unless
    // someone happened to be reading the log live. A device that cannot hold a connection edits
    // against state it has not received, which reaches the user as CONFLICTS rather than as a
    // connectivity fault, so this is what tells those two apart.
    onDisconnect({ documentName, socketId, context }) {
      connections.disconnect(sessionKey(socketId, documentName));
      const last = connections.recent().at(-1);
      const ms = last?.kind === "disconnect" ? last.sessionMs : undefined;
      const who = (context as { user?: string } | undefined)?.user ?? last?.device ?? "unknown";
      console.log(
        `[zync-relay] -conn ${who} ${documentName}${ms === undefined ? "" : ` (${String(Math.round(ms / 1000))}s)`}`,
      );
      return Promise.resolve();
    },

    // Snapshot persistence — content-blind: bytes in, bytes out.
    async onLoadDocument(payload) {
      await hooks.onLoadDocument(payload);
    },

    async onStoreDocument(payload) {
      await hooks.onStoreDocument(payload);
    },
  });

  return {
    hocuspocus,
    connections,
    async close() {
      await hocuspocus.destroy();
    },
  };
}
