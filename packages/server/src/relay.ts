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
 *  - Authenticate via a static shared token (Phase-0 single-device auth).
 *  - Wire snapshot persistence hooks (onLoadDocument / onStoreDocument)
 *    so a server crash/restart doesn't lose in-memory doc state.
 *  - Log doc NAMES (not content) via extension-logger.
 */

import { Hocuspocus } from "@hocuspocus/server";
import { Logger } from "@hocuspocus/extension-logger";
import { SnapshotStore, makeSnapshotHooks } from "./snapshot.js";

export interface RelayConfig {
  /** WebSocket listen port. */
  port: number;
  /** Static shared token for Phase-0 auth. */
  token: string;
  /** Directory for Yjs snapshot persistence. */
  snapshotDir: string;
}

export interface RelayHandle {
  hocuspocus: Hocuspocus;
  /** Gracefully shut down the relay (closes WS server + all connections). */
  close(): Promise<void>;
}

export function createRelay(config: RelayConfig): RelayHandle {
  const store = new SnapshotStore(config.snapshotDir);
  const hooks = makeSnapshotHooks(store);

  const hocuspocus = new Hocuspocus({
    port: config.port,

    // Debounce onStoreDocument calls so rapid edits don't hammer the disk.
    // A burst of updates will be persisted at most every 2 s (debounce)
    // but guaranteed within 10 s (maxDebounce).
    debounce: 2000,
    maxDebounce: 10000,

    extensions: [new Logger()],

    // Phase-0 auth: static shared token.
    // Per-device tokens + TLS are Phase 1 (spec §14).
    async onAuthenticate({ token, documentName }) {
      if (token !== config.token) throw new Error("unauthorized");
      console.log(`[zync-relay] authed for doc: ${documentName}`);
      return { user: "relay" };
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
    async close() {
      await hocuspocus.destroy();
    },
  };
}
