/**
 * Pure decision logic for Zync's mobile connection alerts. No DOM, no Obsidian API —
 * the unit-testable seam behind the sticky "offline" Notice + recovery toast. The host
 * (main.ts) injects a clock, a command sink, and a pending-count reader; feeds it
 * connection / edit / dismiss / timer events; and executes the emitted AlertCommands.
 *
 * Rules (see the design spec): a sustained non-connected state shows ONE sticky after a
 * debounce; an edit while disconnected shows it immediately; one sticky per outage;
 * dismissal suppresses re-show until the next recovery; ≥FLAP_THRESHOLD visible outages
 * inside FLAP_WINDOW_MS flips to "unstable" (suppresses the recovery toast) until a
 * STABILITY_MS connected window clears it. Gates on connection STATE, not pending count.
 */
export const DEBOUNCE_MS = 4000;
export const FLAP_WINDOW_MS = 5 * 60_000;
export const FLAP_THRESHOLD = 3;
export const STABILITY_MS = 60_000;

export type AlertVariant = "offline" | "unstable";

export type AlertCommand =
  | { kind: "showSticky"; variant: AlertVariant }
  | { kind: "hideSticky" }
  | { kind: "toast"; pending: number }
  | { kind: "setTimer"; atMs: number | null };

export interface AlertDeps {
  now: () => number;
  emit: (cmd: AlertCommand) => void;
  pending: () => number;
}

export class ConnectionAlert {
  private connected = true; // assume connected until onStatus says otherwise
  private stickyUp = false;
  private outageVisible = false; // did we show a sticky during the current/last outage
  private dismissed = false; // user tapped away the sticky this outage
  private unstable = false;
  private visibleOutages: number[] = []; // timestamps of shown stickies (flap detection)
  private lastConnectedAt = 0;

  constructor(private readonly d: AlertDeps) {}

  onConn(connected: boolean): void {
    if (connected === this.connected) return; // dedupe sub-state churn
    this.connected = connected;
    if (connected) this.handleReconnect();
    else this.handleDisconnect();
  }

  onEdit(): void {
    if (this.connected || this.stickyUp || this.dismissed) return;
    this.showSticky();
  }

  onDismiss(): void {
    this.stickyUp = false;
    this.dismissed = true;
  }

  onTimer(): void {
    if (this.connected) {
      if (this.unstable && this.d.now() - this.lastConnectedAt >= STABILITY_MS) {
        this.unstable = false;
        this.visibleOutages = [];
      }
      return;
    }
    if (!this.stickyUp && !this.dismissed) this.showSticky();
  }

  private handleDisconnect(): void {
    this.outageVisible = false;
    this.dismissed = false;
    if (!this.stickyUp) this.d.emit({ kind: "setTimer", atMs: this.d.now() + DEBOUNCE_MS });
  }

  private handleReconnect(): void {
    this.d.emit({ kind: "setTimer", atMs: null }); // cancel any debounce
    if (this.stickyUp) {
      this.d.emit({ kind: "hideSticky" });
      this.stickyUp = false;
    }
    if (this.outageVisible && !this.unstable) {
      this.d.emit({ kind: "toast", pending: this.d.pending() });
    }
    this.outageVisible = false;
    this.dismissed = false;
    this.lastConnectedAt = this.d.now();
    if (this.unstable) this.d.emit({ kind: "setTimer", atMs: this.d.now() + STABILITY_MS });
  }

  private showSticky(): void {
    const now = this.d.now();
    this.visibleOutages = this.visibleOutages.filter((t) => now - t < FLAP_WINDOW_MS);
    this.visibleOutages.push(now);
    if (this.visibleOutages.length >= FLAP_THRESHOLD) this.unstable = true;
    this.stickyUp = true;
    this.outageVisible = true;
    this.d.emit({ kind: "setTimer", atMs: null }); // we're showing now; drop the debounce
    this.d.emit({ kind: "showSticky", variant: this.unstable ? "unstable" : "offline" });
  }
}
