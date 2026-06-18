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

  describe("onRecord", () => {
    it("fires onRecord with (path, hash) on every recordWrite", () => {
      const seen: [string, string][] = [];
      const ledger = new EchoLedger();
      ledger.onRecord = (path, hash) => seen.push([path, hash]);
      ledger.recordWrite("a.md", "h1");
      ledger.recordWrite("a.md", "h2");
      expect(seen).toEqual([
        ["a.md", "h1"],
        ["a.md", "h2"],
      ]);
      // The ledger still suppresses both recorded hashes as echoes.
      expect(ledger.isEcho("a.md", "h1")).toBe(true);
      expect(ledger.isEcho("a.md", "h2")).toBe(true);
    });
  });
});
