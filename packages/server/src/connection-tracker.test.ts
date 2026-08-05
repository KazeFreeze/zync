import { describe, it, expect } from "vitest";
import { ConnectionTracker } from "./connection-tracker.js";

/**
 * The relay logged ONE line, on connect only:  `authed <device> for doc: <name>`.
 *
 * That was enough to spot a reconnect storm by eye once — a phone whose socket opened and closed
 * every 5-19s so its initial sync never completed — but only because someone happened to be reading
 * the log at the time. There was no disconnect line, no session duration, and nothing that could be
 * queried after the fact or shown in the admin console.
 *
 * This makes the storm a SIGNAL rather than something you notice.
 */
describe("ConnectionTracker", () => {
  const at = (t: number) => () => t;

  it("reports a live connection after connect", () => {
    let now = 1000;
    const t = new ConnectionTracker({ now: () => now });
    t.connect("s1", "tab-s8", "__zync_index__");

    now = 5000;
    expect(t.live()).toEqual([{ device: "tab-s8", doc: "__zync_index__", since: 1000 }]);
  });

  it("drops it on disconnect and records the session duration", () => {
    let now = 1000;
    const t = new ConnectionTracker({ now: () => now });
    t.connect("s1", "tab-s8", "__zync_index__");
    now = 8000;
    t.disconnect("s1");

    expect(t.live()).toEqual([]);
    const last = t.recent().at(-1);
    expect(last?.kind).toBe("disconnect");
    expect(last?.sessionMs).toBe(7000);
  });

  it("ignores a disconnect for a session it never saw", () => {
    const t = new ConnectionTracker({ now: at(1) });
    t.disconnect("never-connected");
    expect(t.recent()).toEqual([]);
    expect(t.live()).toEqual([]);
  });

  /**
   * THE POINT. Short repeated sessions for the same device+doc are the signature of a link that
   * cannot hold long enough to finish a sync, which is a connectivity failure that otherwise
   * presents as "sync is broken" or, worse, as conflicts from a device editing while behind.
   */
  it("flags a device that keeps reconnecting inside the window", () => {
    let now = 0;
    const t = new ConnectionTracker({ now: () => now, stormWindowMs: 60_000, stormThreshold: 3 });

    for (let i = 0; i < 4; i++) {
      t.connect(`s${String(i)}`, "tab-s8", "__zync_index__");
      now += 6_000;
      t.disconnect(`s${String(i)}`);
      now += 1_000;
    }

    expect(t.storms()).toEqual([{ device: "tab-s8", doc: "__zync_index__", count: 4 }]);
  });

  it("does not flag a healthy long-lived connection", () => {
    let now = 0;
    const t = new ConnectionTracker({ now: () => now, stormWindowMs: 60_000, stormThreshold: 3 });
    t.connect("s1", "desktop", "__zync_index__");
    now = 3_600_000;

    expect(t.storms()).toEqual([]);
  });

  it("forgets reconnects that fall outside the window, so an old storm does not linger", () => {
    let now = 0;
    const t = new ConnectionTracker({ now: () => now, stormWindowMs: 60_000, stormThreshold: 3 });
    for (let i = 0; i < 4; i++) {
      t.connect(`s${String(i)}`, "tab-s8", "d");
      t.disconnect(`s${String(i)}`);
      now += 1_000;
    }
    expect(t.storms()).toHaveLength(1);

    now += 120_000; // well past the window
    expect(t.storms()).toEqual([]);
  });

  it("caps retained events so a long-running relay cannot grow without bound", () => {
    let now = 0;
    const t = new ConnectionTracker({ now: () => now, maxEvents: 10 });
    for (let i = 0; i < 50; i++) {
      t.connect(`s${String(i)}`, "d", "doc");
      now += 1;
    }
    expect(t.recent().length).toBeLessThanOrEqual(10);
  });
});

/**
 * MEMORY BOUND. `connectTimes` was pruned only inside `storms()`, and nothing calls `storms()`
 * unless an operator has the admin console open. On a relay that runs for weeks with ~1500 docs
 * across several devices, that is an unbounded leak: one entry per device+doc pair, each holding
 * an ever-growing array of connect timestamps.
 *
 * Pruning must therefore happen on WRITE, not only on read — the observability tool must not
 * become the thing that degrades the server it observes.
 */
describe("ConnectionTracker — bounded without any reader", () => {
  it("prunes stale reconnect history on connect, with storms() never called", () => {
    let now = 0;
    const t = new ConnectionTracker({ now: () => now, stormWindowMs: 10_000 });

    for (let i = 0; i < 200; i++) {
      t.connect(`s${String(i)}`, "device", `doc-${String(i % 3)}`);
      t.disconnect(`s${String(i)}`);
      now += 60_000; // every connect falls outside the previous one's window
    }

    // 3 docs are still tracked, but each retains only its in-window timestamps, not all 200.
    expect(t.stats().trackedKeys).toBeLessThanOrEqual(3);
    expect(t.stats().retainedTimestamps).toBeLessThanOrEqual(3);
  });

  it("keeps in-window history, so pruning cannot blind the storm detector", () => {
    let now = 0;
    const t = new ConnectionTracker({ now: () => now, stormWindowMs: 60_000, stormThreshold: 3 });
    for (let i = 0; i < 4; i++) {
      t.connect(`s${String(i)}`, "tab", "doc");
      t.disconnect(`s${String(i)}`);
      now += 1_000;
    }
    expect(t.storms()).toEqual([{ device: "tab", doc: "doc", count: 4 }]);
  });

  it("reports live sessions and retained events for the admin console", () => {
    const t = new ConnectionTracker({ now: () => 1 });
    t.connect("a", "d1", "doc");
    t.connect("b", "d2", "doc");
    t.disconnect("a");

    const s = t.stats();
    expect(s.liveSessions).toBe(1);
    expect(s.events).toBe(3);
  });
});
