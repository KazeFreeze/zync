import { describe, expect, it } from "vitest";
import { canRunResumeCatchUp, detectedResumeGap } from "./resume-detector.js";

describe("detectedResumeGap", () => {
  it("detects a suspended process when a poll arrives far beyond its expected cadence", () => {
    expect(detectedResumeGap(1_000, 69_001, 8_000, 60_000)).toBe(true);
  });

  it("does not mistake ordinary timer drift or event-loop congestion for a resume", () => {
    expect(detectedResumeGap(1_000, 69_000, 8_000, 60_000)).toBe(false);
  });

  it("does not infer a resume without a previous tick to compare", () => {
    expect(detectedResumeGap(null, 69_001, 8_000, 60_000)).toBe(false);
  });
});

describe("canRunResumeCatchUp", () => {
  it("coalesces visibility, online, and late-poll signals from the same wake window", () => {
    expect(canRunResumeCatchUp(10_000, 39_999, 30_000)).toBe(false);
    expect(canRunResumeCatchUp(10_000, 40_000, 30_000)).toBe(true);
  });

  it("allows the first resume signal", () => {
    expect(canRunResumeCatchUp(null, 10_000, 30_000)).toBe(true);
  });

  it("does not suppress catch-up indefinitely if the wall clock moves backward", () => {
    expect(canRunResumeCatchUp(10_000, 9_000, 30_000)).toBe(true);
  });
});
