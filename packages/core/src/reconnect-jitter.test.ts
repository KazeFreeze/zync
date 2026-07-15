import { describe, it, expect } from "vitest";
import { reconnectHealJitterMs } from "./reconnect-jitter.js";

describe("reconnectHealJitterMs", () => {
  it("is deterministic for the same deviceId", () => {
    expect(reconnectHealJitterMs("device-a", 15_000)).toBe(
      reconnectHealJitterMs("device-a", 15_000),
    );
  });

  it("stays within [0, maxMs)", () => {
    for (const id of ["a", "device-b", "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", ""]) {
      const j = reconnectHealJitterMs(id, 15_000);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(15_000);
    }
  });

  it("de-synchronizes distinct devices (different ids → usually different offsets)", () => {
    const a = reconnectHealJitterMs("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", 15_000);
    const b = reconnectHealJitterMs("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", 15_000);
    expect(a).not.toBe(b);
  });

  it("returns 0 when maxMs is 0 (disabled)", () => {
    expect(reconnectHealJitterMs("device-a", 0)).toBe(0);
  });
});
