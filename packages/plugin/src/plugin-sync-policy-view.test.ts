import { describe, expect, it } from "vitest";
import { pluginSyncPolicyView, pluginSyncPolicyViewForPolicy } from "./plugin-sync-policy-view.js";

describe("pluginSyncPolicyView", () => {
  it("describes ordinary plugins as syncing by default", () => {
    expect(pluginSyncPolicyView("dataview", undefined)).toEqual({
      enabled: true,
      overridden: false,
      summary: "Settings sync by default",
      reason: "Stores settings that can be shared across devices.",
    });
  });

  it("explains when a plugin has values that stay on this device", () => {
    expect(pluginSyncPolicyView("tasknotes", undefined)).toMatchObject({
      enabled: true,
      overridden: false,
      summary: "Settings sync; some values stay on this device",
    });
  });

  it("makes an explicit off override visible", () => {
    expect(pluginSyncPolicyView("omnisearch", false)).toMatchObject({
      enabled: false,
      overridden: true,
      summary: "Settings not synced — you changed the default",
    });
  });

  it("does not call an explicit value an override when it matches the default", () => {
    expect(pluginSyncPolicyView("omnisearch", true)).toMatchObject({
      enabled: true,
      overridden: false,
      summary: "Settings sync; volatile-only changes are not sent",
    });
  });

  it("describes the empty device-local policy class and an explicit opt-in honestly", () => {
    const policy = { kind: "device-local", reason: "Stores only local state." } as const;
    expect(pluginSyncPolicyViewForPolicy(policy, undefined)).toEqual({
      enabled: false,
      overridden: false,
      summary: "Settings not synced by default",
      reason: "Stores only local state.",
    });
    expect(pluginSyncPolicyViewForPolicy(policy, true)).toMatchObject({
      enabled: true,
      overridden: true,
      summary: "Settings sync — you changed the default",
    });
  });
});
