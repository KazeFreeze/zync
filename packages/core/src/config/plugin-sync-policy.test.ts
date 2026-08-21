import { describe, expect, it } from "vitest";
import {
  pluginSettingsSyncEnabled,
  pluginSyncPolicy,
  policySettingsSyncEnabled,
} from "./plugin-sync-policy.js";

describe("pluginSyncPolicy", () => {
  it.each([
    ["omnisearch", ["useCache", "DANGER_forceSaveCache", "DANGER_httpHost"]],
    [
      "tasknotes",
      [
        "googleCalendarTaskFingerprints",
        "googleCalendarEventIndex",
        "googleCalendarSyncTokens",
        "taskOrgFiltersCollapsed",
      ],
    ],
    ["periodic-notes", ["hasMigratedDailyNoteSettings", "hasMigratedWeeklyNoteSettings"]],
  ])("returns the measured sync-except policy for %s", (id, volatileKeys) => {
    const policy = pluginSyncPolicy(id);
    expect(policy.kind).toBe("sync-except");
    if (policy.kind !== "sync-except") throw new Error("expected sync-except policy");
    expect([...policy.volatileKeys]).toEqual(volatileKeys);
    expect([...policy.deviceLocalKeys]).toEqual(
      id === "tasknotes" ? ["enableGoogleCalendar", "enabledGoogleCalendars"] : [],
    );
    expect(policy.reason).toMatch(/^[A-Z].+\.$/);
  });

  it.each(["notebook-navigator", "featured-image", "unknown-plugin"])(
    "keeps %s on the default sync policy",
    (id) => {
      expect(pluginSyncPolicy(id)).toEqual({
        kind: "sync",
        reason: "Stores settings that can be shared across devices.",
      });
    },
  );
});

describe("pluginSettingsSyncEnabled", () => {
  it("uses the policy default only when there is no explicit CRDT value", () => {
    expect(pluginSettingsSyncEnabled("unknown-plugin", undefined)).toBe(true);
  });

  it("always honors explicit true and false values", () => {
    expect(pluginSettingsSyncEnabled("unknown-plugin", false)).toBe(false);
    expect(pluginSettingsSyncEnabled("unknown-plugin", true)).toBe(true);
  });

  it("keeps a device-local policy off by default while allowing either explicit value", () => {
    const policy = { kind: "device-local", reason: "Stores only local state." } as const;
    expect(policySettingsSyncEnabled(policy, undefined)).toBe(false);
    expect(policySettingsSyncEnabled(policy, true)).toBe(true);
    expect(policySettingsSyncEnabled(policy, false)).toBe(false);
  });
});
