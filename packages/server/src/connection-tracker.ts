/**
 * ConnectionTracker — who is connected to the relay right now, and who keeps reconnecting.
 *
 * The relay used to log exactly one line, on connect only (`authed <device> for doc: <name>`). A
 * reconnect storm — a socket opening and closing every few seconds, so the initial sync never
 * completes — was detectable only by happening to read the log while it was occurring. There was no
 * disconnect line, no session duration, and nothing queryable afterwards.
 *
 * That matters beyond "sync feels slow": a device that cannot hold a connection long enough to
 * catch up will edit against state it has not received, and that surfaces to the user as CONFLICTS
 * rather than as a connectivity problem. Making the storm explicit is what lets the two be told
 * apart from the server side, independently of whether the device's own UI is telling the truth.
 *
 * Pure and dependency-free (clock injected) so the storm logic is unit-testable without a relay.
 */

/** A connect/disconnect that actually happened. */
export interface ConnEvent {
  at: number;
  kind: "connect" | "disconnect";
  device: string;
  doc: string;
  /** Only on `disconnect`: how long the session lasted. */
  sessionMs?: number;
}

/** A connection open right now. */
export interface LiveConn {
  device: string;
  doc: string;
  since: number;
}

/** A device+doc pair reconnecting often enough to be pathological. */
export interface Storm {
  device: string;
  doc: string;
  count: number;
}

export interface ConnectionTrackerOptions {
  now?: () => number;
  /** Ring-buffer bound: a relay runs for weeks, so retained events must not grow forever. */
  maxEvents?: number;
  /** Reconnects are only counted against each other inside this window. */
  stormWindowMs?: number;
  /** Connects within the window at or above this count are a storm. */
  stormThreshold?: number;
}

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_STORM_WINDOW_MS = 120_000;
const DEFAULT_STORM_THRESHOLD = 4;

interface Session {
  device: string;
  doc: string;
  since: number;
}

/**
 * Compose the reconnect-history key.
 *
 * JSON rather than a delimiter-joined string: a device name or document name containing the
 * delimiter would otherwise collide two different pairs into one bucket, silently merging their
 * reconnect counts. (An earlier version joined on a raw control character, which "worked" only
 * because the split used the same byte — and made the file read as BINARY to grep.)
 */
const historyKey = (device: string, doc: string): string => JSON.stringify([device, doc]);

const parseHistoryKey = (key: string): { device: string; doc: string } => {
  const [device, doc] = JSON.parse(key) as [string, string];
  return { device, doc };
};

export class ConnectionTracker {
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly stormWindowMs: number;
  private readonly stormThreshold: number;

  private readonly sessions = new Map<string, Session>();
  private events: ConnEvent[] = [];
  /** Connect timestamps per device+doc, pruned to the storm window on every write. */
  private readonly connectTimes = new Map<string, number[]>();

  constructor(opts: ConnectionTrackerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.stormWindowMs = opts.stormWindowMs ?? DEFAULT_STORM_WINDOW_MS;
    this.stormThreshold = opts.stormThreshold ?? DEFAULT_STORM_THRESHOLD;
  }

  /** `key` identifies the socket, so a device with several docs open is tracked per connection. */
  connect(key: string, device: string, doc: string): void {
    const at = this.now();
    this.sessions.set(key, { device, doc, since: at });
    this.push({ at, kind: "connect", device, doc });

    // Prune on WRITE, not only inside storms(). Nothing calls storms() unless an operator has the
    // admin console open, so read-only pruning let this map grow forever on a relay running for
    // weeks — one entry per device+doc, each an ever-growing timestamp array. An observability
    // tool must not become the thing that degrades the server it observes.
    const k = historyKey(device, doc);
    const cutoff = at - this.stormWindowMs;
    const times = (this.connectTimes.get(k) ?? []).filter((t) => t >= cutoff);
    times.push(at);
    this.connectTimes.set(k, times);
    this.pruneIdleKeys(cutoff, k);
  }

  disconnect(key: string): void {
    const s = this.sessions.get(key);
    if (s === undefined) return; // never saw the connect (restart, or a pre-auth socket) — ignore
    this.sessions.delete(key);
    const at = this.now();
    this.push({ at, kind: "disconnect", device: s.device, doc: s.doc, sessionMs: at - s.since });
  }

  live(): LiveConn[] {
    return [...this.sessions.values()].map((s) => ({
      device: s.device,
      doc: s.doc,
      since: s.since,
    }));
  }

  recent(): ConnEvent[] {
    return [...this.events];
  }

  /**
   * Device+doc pairs that reconnected at least `stormThreshold` times inside `stormWindowMs`.
   * Pruned on read as well as write so a storm that stopped stops being reported — this is a LIVE
   * signal, not a historical one, and a stale alarm is worse than none.
   */
  storms(): Storm[] {
    const cutoff = this.now() - this.stormWindowMs;
    const out: Storm[] = [];
    for (const [k, times] of this.connectTimes) {
      const kept = times.filter((t) => t >= cutoff);
      if (kept.length === 0) {
        this.connectTimes.delete(k);
        continue;
      }
      this.connectTimes.set(k, kept);
      if (kept.length >= this.stormThreshold) {
        const { device, doc } = parseHistoryKey(k);
        out.push({ device, doc, count: kept.length });
      }
    }
    return out.sort((a, b) => b.count - a.count);
  }

  /** Retention counters, so the monitor's own footprint is observable rather than assumed. */
  stats(): {
    liveSessions: number;
    trackedKeys: number;
    retainedTimestamps: number;
    events: number;
  } {
    let retainedTimestamps = 0;
    for (const times of this.connectTimes.values()) retainedTimestamps += times.length;
    return {
      liveSessions: this.sessions.size,
      trackedKeys: this.connectTimes.size,
      retainedTimestamps,
      events: this.events.length,
    };
  }

  /**
   * Drop history for pairs with nothing left in the window. The map is sized by ACTIVE device+doc
   * pairs, which only exist while something is connecting, so this stays bounded work per connect.
   */
  private pruneIdleKeys(cutoff: number, keep: string): void {
    for (const [k, times] of this.connectTimes) {
      if (k === keep) continue;
      const last = times.at(-1);
      if (last !== undefined && last >= cutoff) continue;
      this.connectTimes.delete(k);
    }
  }

  private push(e: ConnEvent): void {
    this.events.push(e);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }
}
