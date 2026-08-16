import { describe, it, expect } from "vitest";
import { pluginApplyFailureNotice } from "./plugin-apply-failure.js";

describe("pluginApplyFailureNotice", () => {
  it("asks for reload when the restart floor holds the desired state", () => {
    const n = pluginApplyFailureNotice("dataview", true, true);
    expect(n.kind).toBe("reload-needed");
    if (n.kind !== "reload-needed") return;
    expect(n.floorOk).toBe(true);
    expect(n.title).toMatch(/reload/i);
    expect(n.detail).toMatch(/dataview/);
  });

  it("reports could-not-apply when neither live apply nor the floor landed", () => {
    // Wanted enabled, but community-plugins.json does not list it — floor write missed too.
    const n = pluginApplyFailureNotice("dataview", true, false);
    expect(n.kind).toBe("reload-needed");
    if (n.kind !== "reload-needed") return;
    expect(n.floorOk).toBe(false);
    expect(n.title).toMatch(/could not apply/i);
  });

  it("treats a desired-disable with id still in the floor file as a double miss", () => {
    const n = pluginApplyFailureNotice("dataview", false, true);
    expect(n.kind).toBe("reload-needed");
    if (n.kind !== "reload-needed") return;
    expect(n.floorOk).toBe(false);
  });
});
