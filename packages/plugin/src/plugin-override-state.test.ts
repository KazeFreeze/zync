import { describe, it, expect } from "vitest";
import { overrideState } from "./plugin-override-state.js";

const S = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe("overrideState", () => {
  it("no deviation when the id is in neither set", () => {
    expect(overrideState("dv", S(), S())).toEqual({
      suppressed: false,
      settingsLocal: false,
      deviated: false,
    });
  });

  it("suppressed (run-here off) is a deviation", () => {
    expect(overrideState("dv", S("dv"), S())).toEqual({
      suppressed: true,
      settingsLocal: false,
      deviated: true,
    });
  });

  it("settings-local (sync-settings off) is a deviation", () => {
    expect(overrideState("dv", S(), S("dv"))).toEqual({
      suppressed: false,
      settingsLocal: true,
      deviated: true,
    });
  });

  it("both overrides together", () => {
    expect(overrideState("dv", S("dv"), S("dv"))).toEqual({
      suppressed: true,
      settingsLocal: true,
      deviated: true,
    });
  });

  it("membership is scoped to the given id", () => {
    expect(overrideState("other", S("dv"), S("dv"))).toEqual({
      suppressed: false,
      settingsLocal: false,
      deviated: false,
    });
  });
});
