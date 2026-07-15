import { describe, it, expect } from "vitest";
import { authDecision } from "./relay.js";

describe("authDecision", () => {
  it("uses verifyToken when provided and attaches the device label", () => {
    const opts = {
      verifyToken: (t: string) => t === "good",
      getDevice: (t: string) => (t === "good" ? "pc-home" : undefined),
    };
    expect(authDecision("good", opts)).toEqual({ user: "pc-home" });
    expect(() => authDecision("bad", opts)).toThrow(/unauthorized/);
  });

  it("falls back to a static token when verifyToken is absent", () => {
    expect(authDecision("s3cret", { staticToken: "s3cret" })).toEqual({ user: "relay" });
    expect(() => authDecision("nope", { staticToken: "s3cret" })).toThrow(/unauthorized/);
  });

  it("verifyToken takes precedence over a matching static token", () => {
    // verifyToken rejects even though the static token would match → unauthorized
    expect(() => authDecision("x", { staticToken: "x", verifyToken: () => false })).toThrow(
      /unauthorized/,
    );
    // verifyToken accepts even though the static token would NOT match → authorized
    expect(authDecision("x", { staticToken: "nope", verifyToken: () => true })).toEqual({
      user: "relay",
    });
  });

  it('defaults the device label to "relay" on the verifyToken path when getDevice is absent', () => {
    expect(authDecision("good", { verifyToken: () => true })).toEqual({ user: "relay" });
  });

  it("throws when no auth is configured", () => {
    expect(() => authDecision("anything", {})).toThrow(/no auth configured/);
  });
});
