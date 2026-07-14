import { describe, it, expect } from "vitest";
import { configReady, configSiblings } from "./config-ready.js";
import type { ConfigEntry } from "./config-entry.js";
import type { VaultPath } from "../ports.js";
const p = (s: string) => s as VaultPath;
const live: ConfigEntry = {
  sha256: "s" as never,
  size: 1,
  category: "plugins",
  deviceId: "d" as never,
};

describe("config-ready dispatch", () => {
  it("themes dispatch to theme siblings/ready", () => {
    expect(configSiblings(p(".obsidian/themes/Foo/theme.css")).sort()).toEqual(
      [".obsidian/themes/Foo/manifest.json", ".obsidian/themes/Foo/theme.css"].sort(),
    );
  });
  it("plugins dispatch to plugin siblings/ready", () => {
    const m = new Map<string, ConfigEntry>([[".obsidian/plugins/dv/main.js", live]]);
    expect(configReady(p(".obsidian/plugins/dv/main.js"), (k) => m.get(k))).toBe(false);
    m.set(".obsidian/plugins/dv/manifest.json", live);
    expect(configReady(p(".obsidian/plugins/dv/main.js"), (k) => m.get(k))).toBe(true);
    expect(configSiblings(p(".obsidian/plugins/dv/main.js"))).toContain(
      ".obsidian/plugins/dv/manifest.json",
    );
  });
  it("snippets are always ready with no extra siblings", () => {
    expect(configReady(p(".obsidian/snippets/x.css"), () => undefined)).toBe(true);
    expect(configSiblings(p(".obsidian/snippets/x.css"))).toEqual([]);
  });
  it("plugin-data is single-file: no siblings, always ready", () => {
    const path = ".obsidian/plugins/dataview/data.json" as VaultPath;
    expect(configSiblings(path)).toEqual([]);
    expect(configReady(path, () => undefined)).toBe(true); // ready even with an empty config map
  });
});
