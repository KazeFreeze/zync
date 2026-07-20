import { describe, it, expect, beforeEach } from "vitest";
import {
  ConnectionAlert,
  DEBOUNCE_MS,
  STABILITY_MS,
  MSG_OFFLINE,
  MSG_UNSTABLE,
  type AlertCommand,
} from "./connection-alert.js";

// Test harness: controllable clock, captured commands, stubbable pending count.
function harness(pending = 0) {
  let clock = 1_000_000; // arbitrary non-zero start
  const cmds: AlertCommand[] = [];
  const alert = new ConnectionAlert({
    now: () => clock,
    emit: (c) => cmds.push(c),
    pending: () => pending,
  });
  return {
    alert,
    cmds,
    advance: (ms: number) => {
      clock += ms;
    },
    setPending: (n: number) => {
      pending = n;
    },
    kinds: () => cmds.map((c) => c.kind),
  };
}

describe("ConnectionAlert", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("sustained outage shows the sticky after the debounce", () => {
    h.alert.onConn(false); // arms the debounce
    expect(h.kinds()).toEqual(["setTimer"]);
    h.advance(DEBOUNCE_MS);
    h.alert.onTimer();
    expect(h.cmds).toContainEqual({ kind: "showSticky", message: MSG_OFFLINE });
  });

  it("reconnect before the debounce shows nothing", () => {
    h.alert.onConn(false);
    h.advance(DEBOUNCE_MS - 1);
    h.alert.onConn(true); // recovered in time
    expect(h.cmds.some((c) => c.kind === "showSticky")).toBe(false);
    // debounce armed then cancelled
    expect(h.cmds).toContainEqual({ kind: "setTimer", atMs: null });
  });

  it("edit while disconnected bypasses the debounce and shows immediately", () => {
    h.alert.onConn(false);
    h.alert.onEdit();
    expect(h.cmds).toContainEqual({ kind: "showSticky", message: MSG_OFFLINE });
  });

  it("only one sticky per outage", () => {
    h.alert.onConn(false);
    h.alert.onEdit();
    h.alert.onEdit();
    expect(h.cmds.filter((c) => c.kind === "showSticky")).toHaveLength(1);
  });

  it("dismiss suppresses re-show for the same outage but re-arms after recovery", () => {
    h.alert.onConn(false);
    h.alert.onEdit(); // sticky shown
    h.alert.onDismiss();
    h.alert.onEdit(); // same outage → suppressed
    expect(h.cmds.filter((c) => c.kind === "showSticky")).toHaveLength(1);
    h.alert.onConn(true); // recovery resets dismissal
    h.alert.onConn(false);
    h.alert.onEdit(); // new outage → shows again
    expect(h.cmds.filter((c) => c.kind === "showSticky")).toHaveLength(2);
  });

  it("recovery toast only when a sticky was shown", () => {
    // outage WITH sticky
    h.alert.onConn(false);
    h.alert.onEdit();
    h.alert.onConn(true);
    expect(h.cmds).toContainEqual({ kind: "toast", message: "Zync reconnected", durationMs: 2500 });
    // outage WITHOUT sticky (reconnect before debounce)
    const h2 = harness();
    h2.alert.onConn(false);
    h2.alert.onConn(true);
    expect(h2.cmds.some((c) => c.kind === "toast")).toBe(false);
  });

  it("recovery toast copy reflects pending count", () => {
    const hp = harness(3);
    hp.alert.onConn(false);
    hp.alert.onEdit();
    hp.alert.onConn(true);
    expect(hp.cmds).toContainEqual({
      kind: "toast",
      message: "Zync reconnected · flushing 3 pending",
      durationMs: 2500,
    });
  });

  it("flap storm flips to unstable and suppresses the recovery toast", () => {
    for (let i = 0; i < 3; i++) {
      h.alert.onConn(false);
      h.alert.onEdit(); // visible outage
      h.alert.onConn(true);
    }
    const lastSticky = h.cmds.filter((c) => c.kind === "showSticky").at(-1);
    expect(lastSticky).toEqual({ kind: "showSticky", message: MSG_UNSTABLE });
    // the 3rd (unstable) reconnect suppresses the toast
    const toasts = h.cmds.filter((c) => c.kind === "toast");
    expect(toasts).toHaveLength(2); // only the first two recoveries toasted
  });

  it("unstable clears after a stable connected window", () => {
    for (let i = 0; i < 3; i++) {
      h.alert.onConn(false);
      h.alert.onEdit();
      h.alert.onConn(true);
    }
    h.advance(STABILITY_MS);
    h.alert.onTimer(); // stability check while connected
    // next outage is offline again, not unstable
    h.alert.onConn(false);
    h.alert.onEdit();
    const lastSticky = h.cmds.filter((c) => c.kind === "showSticky").at(-1);
    expect(lastSticky).toEqual({ kind: "showSticky", message: MSG_OFFLINE });
  });

  it("is inert on redundant same-state calls", () => {
    h.alert.onConn(false);
    const n = h.cmds.length;
    h.alert.onConn(false); // duplicate disconnect (e.g. connecting→disconnected)
    expect(h.cmds.length).toBe(n);
  });
});
