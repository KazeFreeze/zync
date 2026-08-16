/**
 * Pure decision logic for the desktop status-bar / "show status" blob segment.
 *
 * `blobProgress().materialized` counts "checked OR already on disk"; `written` counts bytes that
 * actually moved. The eager policy enqueues every manifest entry at start, so on an already-synced
 * vault `materialized` climbs while `written` stays 0 — reporting that as "Files x/y" claims a
 * download that never happened. Mobile's arriving notice already gates on `written > 0`; this is
 * the same gate for the desktop segment, with an optional "checking" label for verification-only
 * progress so the bar does not go dark during a real re-verify.
 */

export interface BlobProgressInputs {
  total: number;
  materialized: number;
  failed: number;
  /** Bytes that actually had to be fetched — not mere on-disk verification. */
  written: number;
  /** `engine.blobsSettled()` — no queued/in-flight/retry work left. */
  settled: boolean;
}

export interface BlobStatusSegment {
  icon: string;
  /** Short segment text, e.g. "Files 3/10" or "Checking 3/10". */
  text: string;
  /** Failed count folded into text when > 0; kept so parked failures stay visible. */
  failed: number;
}

/**
 * The desktop blob segment, or null for "render nothing".
 *
 * Real transfers (`written > 0`) keep the download wording. Verification-only progress is labeled
 * "Checking", never "Files", so a re-verify on an already-synced vault cannot read as a download.
 */
export function blobStatusSegment(b: BlobProgressInputs): BlobStatusSegment | null {
  if (b.total <= 0) return null;
  if (b.settled || b.materialized >= b.total) return null;

  const done = Math.min(b.materialized, b.total);
  const failedSuffix = b.failed > 0 ? ` (${String(b.failed)} failed)` : "";

  // Same real-transfer gate as arrivingInputs: without `written > 0` we are only re-checking
  // files already on disk — never claim those as received downloads.
  if (b.written > 0) {
    return {
      icon: "download",
      text: `Files ${String(done)}/${String(b.total)}${failedSuffix}`,
      failed: b.failed,
    };
  }

  return {
    icon: "search",
    text: `Checking ${String(done)}/${String(b.total)}${failedSuffix}`,
    failed: b.failed,
  };
}
