import { describe, it, expect } from "vitest";
import { EchoLedger } from "./echo.js";

const sha = (s: string) => `sha-${s}`; // opaque content-hash stand-in (real hashing is an adapter concern)

describe("EchoLedger", () => {
  it("recognizes our own write as an echo (final disk bytes match intent)", () => {
    const led = new EchoLedger();
    led.recordWrite("a.md", sha("v2"));
    expect(led.isEcho("a.md", sha("v2"))).toBe(true);
  });
  it("a foreign write is NOT an echo (a formatter rewrote it → different hash)", () => {
    const led = new EchoLedger();
    led.recordWrite("a.md", sha("v2"));
    expect(led.isEcho("a.md", sha("v2-linted"))).toBe(false);
  });
  it("consumes a matched entry once (a second identical event is external)", () => {
    const led = new EchoLedger();
    led.recordWrite("a.md", sha("v2"));
    expect(led.isEcho("a.md", sha("v2"))).toBe(true);
    expect(led.isEcho("a.md", sha("v2"))).toBe(false);
  });
  it("MULTI-ENTRY: pipelined writes are BOTH recognized as echoes (the NEW-7 fix)", () => {
    const led = new EchoLedger();
    led.recordWrite("a.md", sha("v2"));
    led.recordWrite("a.md", sha("v3")); // recorded before v2's fs event arrives
    expect(led.isEcho("a.md", sha("v2"))).toBe(true); // v2 event → echo
    expect(led.isEcho("a.md", sha("v3"))).toBe(true); // v3 event → echo
    expect(led.isEcho("a.md", sha("v3"))).toBe(false); // already consumed
  });
  it("is per-path", () => {
    const led = new EchoLedger();
    led.recordWrite("a.md", sha("x"));
    expect(led.isEcho("b.md", sha("x"))).toBe(false);
  });

  it("does not suppress a genuine later edit when its watcher token has expired", () => {
    let now = 1_000;
    const led = new EchoLedger({ now: () => now, ttlMs: 100 });
    led.recordWrite("a.md", sha("old-content"));

    now += 101; // The watcher missed the engine write; the user later restores those exact bytes.
    expect(led.isEcho("a.md", sha("old-content"))).toBe(false);
  });

  it("caps missed watcher tokens per path without weakening recent echo suppression", () => {
    const led = new EchoLedger({ maxPerPath: 2, maxTotal: 10 });
    led.recordWrite("a.md", sha("v1"));
    led.recordWrite("a.md", sha("v2"));
    led.recordWrite("a.md", sha("v3"));

    expect(led.isEcho("a.md", sha("v1"))).toBe(false);
    expect(led.isEcho("a.md", sha("v2"))).toBe(true);
    expect(led.isEcho("a.md", sha("v3"))).toBe(true);
  });

  it("caps missed watcher tokens globally on the write path", () => {
    let now = 0;
    const led = new EchoLedger({ now: () => ++now, maxPerPath: 10, maxTotal: 2 });
    led.recordWrite("a.md", sha("a"));
    led.recordWrite("b.md", sha("b"));
    led.recordWrite("c.md", sha("c"));

    expect(led.isEcho("a.md", sha("a"))).toBe(false);
    expect(led.isEcho("b.md", sha("b"))).toBe(true);
    expect(led.isEcho("c.md", sha("c"))).toBe(true);
  });
});
