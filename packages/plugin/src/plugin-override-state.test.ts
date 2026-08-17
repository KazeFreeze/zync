import { describe, it, expect } from "vitest";
import { overrideState } from "./plugin-override-state.js";

const S = (...ids: string[]): ReadonlySet<string> => new Set(ids);
const M = (...entries: [string, boolean][]): ReadonlyMap<string, boolean> => new Map(entries);

describe("overrideState", () => {
  it("no deviation when the id is in neither set", () => {
    expect(overrideState("dv", S(), M())).toMatchObject({
      suppressed: false,
      settingsLocal: false,
      deviated: false,
    });
  });

  it("suppressed (run-here off) is a deviation", () => {
    expect(overrideState("dv", S("dv"), M())).toMatchObject({
      suppressed: true,
      settingsLocal: false,
      deviated: true,
    });
  });

  it("settings-local (sync-settings off) is a deviation", () => {
    expect(overrideState("dv", S(), M(["dv", false]))).toMatchObject({
      suppressed: false,
      settingsLocal: true,
      deviated: true,
    });
  });

  it("both overrides together", () => {
    expect(overrideState("dv", S("dv"), M(["dv", false]))).toMatchObject({
      suppressed: true,
      settingsLocal: true,
      deviated: true,
    });
  });

  it("membership is scoped to the given id", () => {
    expect(overrideState("other", S("dv"), M(["dv", false]))).toMatchObject({
      suppressed: false,
      settingsLocal: false,
      deviated: false,
    });
  });
});
