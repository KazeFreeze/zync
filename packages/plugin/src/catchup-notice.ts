/**
 * Pure decision logic for the mobile "catching up" notice. No DOM, no Obsidian import — the same
 * unit-testable seam as arriving-view.ts, connection-alert.ts and synced-plugins-gate.ts.
 *
 * WHY THIS EXISTS. Android 14+ freezes a cached app process about ten seconds after it is
 * backgrounded; every thread is suspended. Battery-optimisation exemption does NOT prevent it, and
 * the only documented exception is a foreground service, which an Obsidian PLUGIN cannot declare.
 * So a phone genuinely cannot stay synced in the background, and there is no version of this we
 * can engineer away. Reconnect-on-resume (already wired to `visibilitychange` in main.ts) is the
 * most that can be done about the connection itself.
 *
 * The remaining harm IS fixable. After resume there is a window where the socket is back but the
 * shared index has not arrived yet, and an edit made in that window diverges against state this
 * device never received — which then surfaces as a conflict, blaming the merge for what is really
 * a connectivity artifact. This makes that window visible.
 *
 * DELIBERATELY NON-BLOCKING: it warns, it does not gate the edit. Blocking edits on your own notes
 * to protect you from a race is a worse trade than telling you the truth and letting you decide.
 */

/**
 * How long to tolerate an unsynced index before saying anything.
 *
 * Measured on a real Galaxy Tab S8 against a live relay: a foregrounded catch-up completes in
 * ~2.5s. Announcing that and retracting it two seconds later is worse than silence — a notice that
 * appears routinely and resolves itself is one you learn to ignore, which costs you the times it
 * actually matters.
 */
export const CATCHUP_GRACE_MS = 3_000;

export interface CatchupInputs {
  /** Desktop already shows this continuously in the status bar; this surface is mobile-only. */
  isMobile: boolean;
  /** `engine.start()` has been kicked off. Startup has its own copy. */
  started: boolean;
  /** Transport reports a live connection. */
  connected: boolean;
  /** `engine.isIndexSynced()` — the shared index has actually arrived from the relay. */
  indexSynced: boolean;
  /** How long we have been connected-but-unsynced. */
  waitingMs: number;
  /** Whether the notice is on screen right now; drives the no-retract rule. */
  showing: boolean;
}

export interface CatchupNotice {
  text: string;
}

/** The notice to display, or null for "say nothing". */
export function catchupNotice(i: CatchupInputs): CatchupNotice | null {
  if (!i.isMobile) return null;
  if (!i.started) return null;
  // Disconnected is the offline sticky's job. Two notices about one problem is noise, and the
  // offline one is the more actionable of the two.
  if (!i.connected) return null;
  if (i.indexSynced) return null;
  // Grace period, unless it is already up — once shown it stays until genuinely caught up, so it
  // cannot flicker on and off while the catch-up drags.
  if (!i.showing && i.waitingMs < CATCHUP_GRACE_MS) return null;

  return {
    // States the situation and its consequence, without implying the edit is refused.
    text: "Catching up with your other devices. Recent changes from elsewhere may not be here yet.",
  };
}
