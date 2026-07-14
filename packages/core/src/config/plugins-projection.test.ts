import { describe, it, expect } from "vitest";
import { managedSet, projectArray, ingestEnabled, arraysEqual } from "./plugins-projection.js";

// managed(id) = optIn ∧ platformAllowed ∧ ¬suppressed
const inputs = {
  optIn: new Set(["dv", "tp", "mobileonly", "supp"]),
  isDesktopOnly: new Set(["deskonly"]), // plugins whose manifest.isDesktopOnly === true
  suppressed: new Set(["supp"]),
};

describe("managedSet", () => {
  it("includes opted-in, platform-allowed, non-suppressed ids", () => {
    const m = managedSet(inputs.optIn, inputs.isDesktopOnly, inputs.suppressed, false /*isMobile*/);
    expect([...m].sort()).toEqual(["dv", "mobileonly", "tp"]); // supp excluded
  });
  it("on mobile, excludes desktop-only ids", () => {
    const optIn = new Set(["dv", "deskonly"]);
    const m = managedSet(optIn, new Set(["deskonly"]), new Set(), true /*isMobile*/);
    expect([...m].sort()).toEqual(["dv"]);
  });
});

describe("projectArray", () => {
  const managed = new Set(["dv", "tp"]);
  const enabled = (id: string) => id === "dv"; // dv enabled, tp not
  it("adds managed+enabled, removes managed+disabled, PRESERVES non-managed (local-only)", () => {
    const current = ["tp", "localonly"]; // tp managed+disabled -> remove; localonly not managed -> keep
    expect(projectArray(current, managed, enabled)).toEqual(["localonly", "dv"]);
  });
  it("is idempotent (projecting an already-correct array changes nothing)", () => {
    const out = projectArray(["localonly", "dv"], managed, enabled);
    expect(out).toEqual(["localonly", "dv"]);
  });
});

describe("ingestEnabled", () => {
  const managed = new Set(["dv", "tp"]);
  it("reads enabled=array-membership for managed ids ONLY", () => {
    const deltas = ingestEnabled(["dv", "localonly"], managed);
    expect(deltas).toEqual(
      new Map([
        ["dv", true],
        ["tp", false],
      ]),
    ); // localonly ignored (not managed)
  });
});

describe("arraysEqual", () => {
  it("order-insensitive set equality", () => {
    expect(arraysEqual(["a", "b"], ["b", "a"])).toBe(true);
    expect(arraysEqual(["a"], ["a", "b"])).toBe(false);
  });
});
