import { describe, it, expect } from "vitest";
import { catchupNotice, CATCHUP_GRACE_MS, type CatchupInputs } from "./catchup-notice.js";

const inputs = (over: Partial<CatchupInputs> = {}): CatchupInputs => ({
  isMobile: true,
  started: true,
  connected: true,
  indexSynced: false,
  waitingMs: CATCHUP_GRACE_MS + 1,
  showing: false,
  ...over,
});

/**
 * Android 14+ freezes a cached app ~10s after backgrounding, and only a foreground service is
 * exempt — which a plugin cannot declare. So the phone genuinely CANNOT stay synced in the
 * background, and reconnect-on-resume (already wired via visibilitychange) is the most that can
 * be done about the connection itself.
 *
 * What remains fixable is the harm: after resume there is a window where the socket is back but
 * the shared index has NOT arrived, and editing in that window diverges against state this device
 * simply has not received. That is where the conflicts come from. This notice makes that window
 * VISIBLE without blocking the edit.
 */
describe("catchupNotice", () => {
  it("warns while connected but not yet caught up", () => {
    const n = catchupNotice(inputs());
    expect(n).not.toBeNull();
    expect(n?.text).toMatch(/catching up|up to date/i);
  });

  it("clears once the index has synced", () => {
    expect(catchupNotice(inputs({ indexSynced: true, showing: true }))).toBeNull();
  });

  /**
   * Measured on a real Tab S8: a foregrounded catch-up completes in ~2.5s. Showing a notice for
   * two seconds and yanking it away is worse than saying nothing — it trains you to ignore it.
   */
  it("stays silent for a fast catch-up, rather than flashing", () => {
    expect(catchupNotice(inputs({ waitingMs: 500 }))).toBeNull();
    expect(catchupNotice(inputs({ waitingMs: CATCHUP_GRACE_MS - 1 }))).toBeNull();
  });

  it("does not retract once shown, so it cannot flicker while still catching up", () => {
    const n = catchupNotice(inputs({ waitingMs: 0, showing: true }));
    expect(n).not.toBeNull();
  });

  /** The offline sticky already owns this case; two notices about one problem is noise. */
  it("defers to the offline alert when disconnected", () => {
    expect(catchupNotice(inputs({ connected: false }))).toBeNull();
    expect(catchupNotice(inputs({ connected: false, showing: true }))).toBeNull();
  });

  it("is mobile-only, because desktop already shows this in the status bar", () => {
    expect(catchupNotice(inputs({ isMobile: false }))).toBeNull();
  });

  it("says nothing before the engine has started, where startup copy already applies", () => {
    expect(catchupNotice(inputs({ started: false }))).toBeNull();
  });

  /** It must not imply the edit is blocked — edits are deliberately still allowed. */
  it("does not tell the user they cannot edit", () => {
    const text = catchupNotice(inputs())?.text ?? "";
    expect(text).not.toMatch(/can(not|'t) edit|read.only|blocked|wait before/i);
  });
});
