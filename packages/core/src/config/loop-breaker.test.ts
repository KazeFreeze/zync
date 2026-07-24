import { describe, it, expect } from "vitest";
import { ConfigLoopBreaker, LOOP_WINDOW_MS, LOOP_MAX_PUBLISHES } from "./loop-breaker.js";

function h() {
  let t = 0;
  const b = new ConfigLoopBreaker({ now: () => t });
  return {
    b,
    adv: (ms: number) => {
      t += ms;
    },
  };
}
const P = ".obsidian/plugins/x/data.json";
const Q = ".obsidian/plugins/y/data.json";

describe("ConfigLoopBreaker", () => {
  it("allows up to the cap, trips on the next, record returns true exactly once", () => {
    const { b } = h();
    let tripped = 0;
    for (let i = 0; i < LOOP_MAX_PUBLISHES; i++) {
      expect(b.allow(P)).toBe(true);
      if (b.record(P)) tripped++;
    }
    expect(tripped).toBe(0); // cap publishes, not yet tripped
    expect(b.allow(P)).toBe(true); // the (cap+1)th publish is still issued...
    expect(b.record(P)).toBe(true); // ...and THIS one trips
    expect(b.allow(P)).toBe(false); // now suppressed
    expect(b.record(P)).toBe(false); // trips only once
  });
  it("a slow drip (<=cap per window) never trips", () => {
    const { b, adv } = h();
    for (let i = 0; i < LOOP_MAX_PUBLISHES * 3; i++) {
      b.allow(P);
      expect(b.record(P)).toBe(false);
      adv(LOOP_WINDOW_MS + 1); // each publish falls outside the previous window
    }
    expect(b.allow(P)).toBe(true);
  });
  it("per-path isolation", () => {
    const { b } = h();
    for (let i = 0; i <= LOOP_MAX_PUBLISHES; i++) b.record(P);
    expect(b.allow(P)).toBe(false);
    expect(b.allow(Q)).toBe(true);
  });
  it("reset re-arms", () => {
    const { b } = h();
    for (let i = 0; i <= LOOP_MAX_PUBLISHES; i++) b.record(P);
    expect(b.allow(P)).toBe(false);
    b.reset(P);
    expect(b.allow(P)).toBe(true);
  });
});
