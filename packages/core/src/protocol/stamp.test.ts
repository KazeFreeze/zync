import { describe, it, expect } from "vitest";
import type { DeviceId, Sha256 } from "../ports.js";
import { makeStamp, stampHash, stampsEqual } from "./stamp.js";

const sha = (s: string): Sha256 => s as Sha256;
const dev = (s: string): DeviceId => s as DeviceId;

describe("stamp (0b-2 §B — content stamps, HASH-ONLY compare)", () => {
  it("makeStamp formats as `${sha}:${deviceId}`", () => {
    expect(makeStamp(sha("abc123"), dev("dev-1"))).toBe("abc123:dev-1");
  });

  it("stampHash extracts the hash part", () => {
    expect(stampHash("abc123:dev-1")).toBe("abc123");
  });

  it("stampHash uses the LAST colon (defensive if a hash ever held one)", () => {
    expect(stampHash("ab:cd:dev-1")).toBe("ab:cd");
  });

  it("stampHash returns the whole string when there is no colon", () => {
    expect(stampHash("abc123")).toBe("abc123");
  });

  it("ANTI-HANG (NEW-1): same hash + DIFFERENT device → EQUAL", () => {
    // Two devices converging to identical content must NOT show perpetual inequality,
    // else waitConverged hangs forever.
    const a = makeStamp(sha("samehash"), dev("dev-a"));
    const b = makeStamp(sha("samehash"), dev("dev-b"));
    expect(a).not.toBe(b); // the full strings differ (provenance)
    expect(stampsEqual(a, b)).toBe(true); // but the HASH parts are equal
  });

  it("different hashes → NOT equal (even with the same device)", () => {
    const a = makeStamp(sha("hash-1"), dev("dev-a"));
    const b = makeStamp(sha("hash-2"), dev("dev-a"));
    expect(stampsEqual(a, b)).toBe(false);
  });

  it("null vs null → equal", () => {
    expect(stampsEqual(null, null)).toBe(true);
  });

  it("null vs non-null → not equal (both orders)", () => {
    const s = makeStamp(sha("h"), dev("d"));
    expect(stampsEqual(null, s)).toBe(false);
    expect(stampsEqual(s, null)).toBe(false);
  });
});
