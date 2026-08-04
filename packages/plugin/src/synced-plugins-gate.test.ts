import { describe, it, expect } from "vitest";
import { syncedPluginsGate, type SyncedPluginsGateInputs } from "./synced-plugins-gate.js";

const inputs = (over: Partial<SyncedPluginsGateInputs> = {}): SyncedPluginsGateInputs => ({
  indexReadable: true,
  engineReady: true,
  connected: true,
  ...over,
});

describe("syncedPluginsGate", () => {
  it("renders writable rows once the index is readable and the engine is started", () => {
    const g = syncedPluginsGate(inputs());
    expect(g.kind).toBe("rows");
    if (g.kind !== "rows") return;
    expect(g.writable).toBe(true);
    expect(g.notice).toBeNull();
  });

  /**
   * THE POINT OF THIS MODULE. A hydrated index is genuine local truth the moment the snapshot
   * loads, which is the third statement of engine.start(). Gating the rows on the WHOLE of
   * start() (index handshake budget, then config bootstrap, then the full vault walk) hid
   * settings that were already in hand for tens of seconds on a real vault.
   */
  it("renders rows while the engine is still starting, as soon as the index is readable", () => {
    const g = syncedPluginsGate(inputs({ engineReady: false }));
    expect(g.kind).toBe("rows");
  });

  it("makes those rows read-only, because writes are not accepted until start() completes", () => {
    const g = syncedPluginsGate(inputs({ engineReady: false }));
    if (g.kind !== "rows") throw new Error("expected rows");
    expect(g.writable).toBe(false);
    expect(g.notice).not.toBeNull();
    expect(g.notice).toMatch(/starting/i);
  });

  it("waits when the index holds nothing yet, and says the settings are still coming", () => {
    const g = syncedPluginsGate(inputs({ indexReadable: false }));
    expect(g.kind).toBe("waiting");
    if (g.kind !== "waiting") return;
    expect(g.title).toMatch(/loading/i);
    expect(g.desc).toMatch(/server/i);
  });

  /**
   * Offline with nothing stored, "Loading…" is a lie: nothing is on the way. Say what is actually
   * true and what would fix it, rather than implying progress that cannot happen.
   */
  it("does not claim to be loading when offline with nothing stored", () => {
    const g = syncedPluginsGate(inputs({ indexReadable: false, connected: false }));
    if (g.kind !== "waiting") throw new Error("expected waiting");
    expect(g.title).not.toMatch(/loading/i);
    expect(g.title).toMatch(/offline|unavailable/i);
    expect(g.desc).toMatch(/connect/i);
  });

  /** Being offline is irrelevant once the snapshot is in hand — that is the whole point of it. */
  it("renders rows offline when the index hydrated from the local snapshot", () => {
    const g = syncedPluginsGate(inputs({ connected: false }));
    expect(g.kind).toBe("rows");
    if (g.kind !== "rows") return;
    expect(g.writable).toBe(true);
  });
});
