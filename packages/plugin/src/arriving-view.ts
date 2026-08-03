/**
 * Pure decision logic for the "arriving" surfaces: the desktop status-bar segment and the mobile
 * arrival notice. No DOM and no Obsidian import, so the wording and the show/retire hysteresis
 * are unit-testable (the same seam as stuck-copy.ts and connection-alert.ts).
 *
 * NOT first-sync-only, despite that being the motivating case: the threshold fires on any bulk
 * arrival, including a large catch-up after a phone has slept. That is why the copy counts files
 * rather than claiming to be receiving the vault.
 */

/** Below this on BOTH planes an ordinary few-file sync would nag, so stay silent. */
export const ARRIVING_NOTICE_THRESHOLD = 20;

export interface ArrivingInputs {
  /** The engine is started and its ports are wired. */
  started: boolean;
  /** The transport reports a live connection. */
  connected: boolean;
  /** `engine.isIndexHydrated()` — real index state, restored or synced. */
  hydrated: boolean;
  /** `syncSnapshot().arriving.length`. */
  arriving: number;
  /** `blobProgress().total - blobProgress().materialized`. */
  blobsOutstanding: number;
  /** Whether the notice is on screen right now; drives the retire hysteresis. */
  showing: boolean;
}

export interface ArrivingSegment {
  icon: string;
  text: string;
  /** The segment's only accessible name (sets both `aria-label` and `title`). Set here, in the
   *  pure module, so it is unit-tested and cannot drift from `text`. */
  tooltip: string;
}

/**
 * The status-bar segment, or null for "render nothing".
 *
 * EXCEPTIONS-ONLY: at zero we render nothing rather than "0 arriving", because a visible zero is
 * an affirmative claim that nothing is inbound, and a decorator that silently stops working would
 * then read as reassurance. Nothing is the safe degraded state.
 */
export function arrivingSegment(i: ArrivingInputs): ArrivingSegment | null {
  if (!i.started) return null;
  // Absence is not a real value: before the index hydrates every count is 0 because the maps are
  // EMPTY, not because nothing is coming. Say so explicitly instead of rendering a zero.
  if (i.connected && !i.hydrated)
    return {
      icon: "refresh-cw",
      text: "receiving index",
      tooltip:
        "Connected. Zync is getting the list of files on your other devices. The count appears once it arrives.",
    };
  if (i.arriving > 0)
    return {
      icon: "download-cloud",
      text: `${i.arriving.toLocaleString()} arriving`,
      tooltip: `${i.arriving.toLocaleString()} files are downloading from your other devices. They will appear as they arrive.`,
    };
  return null;
}

export type ArrivingNotice =
  | { kind: "hidden" }
  | { kind: "shown"; title: string; detail: string | null };

/**
 * The mobile notice state. Mobile has no status bar, so this is the ONLY sync-progress surface
 * there, which is why it covers blobs too: prose drains in seconds on an attachment-heavy vault
 * and the remaining hundreds of MB would otherwise download in total silence.
 */
export function arrivingNotice(i: ArrivingInputs): ArrivingNotice {
  if (!i.started) return { kind: "hidden" };
  if (i.connected && !i.hydrated)
    return {
      kind: "shown",
      title: "Receiving your library",
      detail: "Checking what is on your other devices.",
    };

  const outstanding = i.arriving > 0 || i.blobsOutstanding > 0;
  const overThreshold =
    i.arriving >= ARRIVING_NOTICE_THRESHOLD || i.blobsOutstanding >= ARRIVING_NOTICE_THRESHOLD;
  // Hysteresis: cross the threshold to APPEAR, but retire only at zero. Retiring at the threshold
  // would make the notice vanish at "19 remaining", which reads as a failure rather than progress.
  if (!(i.showing ? outstanding : overThreshold)) return { kind: "hidden" };

  // Offline: the counts are still true (this work IS outstanding) but "Receiving" asserts an active
  // transfer that is not happening. Say what is true instead. "Waiting", not "Paused" — `Paused` is
  // already the config loop-breaker's title and must not come to mean two things.
  if (!i.connected) {
    const total = i.arriving + i.blobsOutstanding;
    return {
      kind: "shown",
      title: "Waiting",
      detail: `${total.toLocaleString()} file${total === 1 ? "" : "s"} still to download. This continues when you are back online.`,
    };
  }

  // Pluralized: the hysteresis above holds the notice open until BOTH planes reach zero, so 1 is
  // not a corner case — it is the LAST FRAME of every drain, not a rare input.
  if (i.arriving > 0 && i.blobsOutstanding > 0)
    return {
      kind: "shown",
      title: `Receiving ${i.arriving.toLocaleString()} file${i.arriving === 1 ? "" : "s"}`,
      detail: `Plus ${i.blobsOutstanding.toLocaleString()} attachment${i.blobsOutstanding === 1 ? "" : "s"} downloading.`,
    };
  if (i.arriving > 0)
    return {
      kind: "shown",
      title: `Receiving ${i.arriving.toLocaleString()} file${i.arriving === 1 ? "" : "s"}`,
      detail: null,
    };
  return {
    kind: "shown",
    title: `Receiving ${i.blobsOutstanding.toLocaleString()} attachment${i.blobsOutstanding === 1 ? "" : "s"}`,
    detail: null,
  };
}
