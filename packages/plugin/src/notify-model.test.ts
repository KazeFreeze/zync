import { describe, it, expect } from "vitest";
import { KIND_ICON, KIND_STICKY, explainNotifyProps, type NotifyKind } from "./notify-model.js";

const KINDS: NotifyKind[] = ["success", "info", "warning", "error"];

describe("notify-model", () => {
  it("every kind has an icon and a duration", () => {
    for (const k of KINDS) {
      expect(typeof KIND_ICON[k]).toBe("string");
      expect(KIND_ICON[k].length).toBeGreaterThan(0);
      expect(typeof KIND_STICKY[k]).toBe("number");
    }
  });
  it("warning and error are sticky (0); success and info auto-dismiss", () => {
    expect(KIND_STICKY.warning).toBe(0);
    expect(KIND_STICKY.error).toBe(0);
    expect(KIND_STICKY.success).toBeGreaterThan(0);
    expect(KIND_STICKY.info).toBeGreaterThan(0);
  });
  it("explainNotifyProps: synced auto-dismisses; other verdicts are sticky", () => {
    expect(explainNotifyProps("syncing")).toEqual({
      kind: "success",
      icon: "check-circle",
      durationMs: 4000,
    });
    expect(explainNotifyProps("pending").durationMs).toBe(0);
    expect(explainNotifyProps("not-tracked")).toEqual({
      kind: "info",
      icon: "help-circle",
      durationMs: 0,
    });
    expect(explainNotifyProps("excluded")).toEqual({ kind: "info", icon: "ban", durationMs: 0 });
  });
});
