/**
 * Pure decision logic for the Synced-plugins section's readiness gate. No DOM and no Obsidian
 * import, so the states AND their copy are unit-testable (the same seam as arriving-view.ts,
 * stuck-copy.ts and connection-alert.ts).
 *
 * WHY THIS EXISTS. The section used to gate on `engineReady`, which the plugin sets only after
 * the WHOLE of `engine.start()` resolves: the bounded index handshake, then config bootstrap,
 * then a full vault walk over every note and every blob. On a real vault that is tens of seconds,
 * and it rendered "Loading plugin sync settings" for all of it.
 *
 * That wait was never necessary. The index hydrates from the LOCAL snapshot in the third statement
 * of `start()`, so the settings are genuine local truth almost immediately — which is exactly what
 * persisting the index was for. Gating on the engine being fully up threw that away, and the copy
 * claimed to be loading something it already had.
 *
 * The gate therefore asks two SEPARATE questions instead of one:
 *   - can we SHOW the settings?  ⇒ is the index readable (hydrated + maps wired)
 *   - can we ACCEPT a change?    ⇒ has start() finished
 * Conflating them is the bug.
 */

export interface SyncedPluginsGateInputs {
  /** `engine.isIndexReadable()` — the index-backed maps exist AND hold real state. */
  indexReadable: boolean;
  /** `engine.start()` has fully resolved, so the engine will accept writes. */
  engineReady: boolean;
  /** The transport reports a live connection. */
  connected: boolean;
}

export type SyncedPluginsGate =
  | {
      kind: "rows";
      /** False while start() is still running: show the real state, refuse writes. */
      writable: boolean;
      /** Explains the read-only window. Null when the rows are fully live. */
      notice: string | null;
    }
  | { kind: "waiting"; title: string; desc: string };

/**
 * Decide what the Synced-plugins section should render. The caller still owns the master-toggle
 * "disabled" case; this is only about readiness.
 */
export function syncedPluginsGate(i: SyncedPluginsGateInputs): SyncedPluginsGate {
  if (!i.indexReadable) {
    // Nothing local to show. Distinguish "on the way" from "cannot arrive": offline with no stored
    // snapshot, "Loading…" is simply false — nothing is in flight, and the user needs to know the
    // one thing that would fix it.
    return i.connected
      ? {
          kind: "waiting",
          title: "Loading plugin sync settings",
          desc: "Waiting for your synced settings to arrive from the server. This device has not stored them yet.",
        }
      : {
          kind: "waiting",
          title: "Plugin sync settings unavailable offline",
          desc: "This device has not synced these settings yet, and the server is unreachable. Connect once and they are kept for offline use.",
        };
  }

  if (!i.engineReady) {
    return {
      kind: "rows",
      writable: false,
      notice:
        "Zync is still starting. These are your settings from this device's last sync — changes can be made in a moment.",
    };
  }

  return { kind: "rows", writable: true, notice: null };
}
