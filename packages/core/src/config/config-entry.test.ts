import { describe, it, expect } from "vitest";
import {
  CONFIG_ZONE_PREFIXES,
  isConfigZone,
  configCategoryOf,
  pluginIdOf,
} from "./config-entry.js";
import type { VaultPath } from "../ports.js";

const p = (s: string) => s as VaultPath;

describe("config-entry zone helpers", () => {
  it("themes + snippets + plugins prefixes are the config zone", () => {
    expect(CONFIG_ZONE_PREFIXES).toEqual([
      ".obsidian/themes/",
      ".obsidian/snippets/",
      ".obsidian/plugins/",
    ]);
  });
  it("isConfigZone passes themes/snippets, rejects non-config/nested paths", () => {
    expect(isConfigZone(p(".obsidian/themes/Foo/theme.css"))).toBe(true);
    expect(isConfigZone(p(".obsidian/snippets/x.css"))).toBe(true);
    expect(isConfigZone(p(".obsidian/appearance.json"))).toBe(false);
    expect(isConfigZone(p(".obsidian/zync/base/x.json"))).toBe(false);
    expect(isConfigZone(p("notes/a.md"))).toBe(false);
  });
  it("configCategoryOf returns the category or undefined", () => {
    expect(configCategoryOf(p(".obsidian/themes/Foo/theme.css"))).toBe("themes");
    expect(configCategoryOf(p(".obsidian/snippets/x.css"))).toBe("snippets");
    expect(configCategoryOf(p("notes/a.md"))).toBeUndefined();
  });
});

describe("plugins config zone", () => {
  it("bundle files of a non-zync plugin are in-zone, category plugins", () => {
    for (const f of ["manifest.json", "main.js", "styles.css"]) {
      const path = p(`.obsidian/plugins/dataview/${f}`);
      expect(isConfigZone(path)).toBe(true);
      expect(configCategoryOf(path)).toBe("plugins");
    }
  });
  it("unknown / nested files under a plugin dir are OUT of zone", () => {
    expect(isConfigZone(p(".obsidian/plugins/dataview/extra/foo.js"))).toBe(false);
  });
  it("a nested bundle-named file is OUT of zone (allow-list is airtight)", () => {
    expect(isConfigZone(p(".obsidian/plugins/dataview/extra/main.js"))).toBe(false);
    expect(configCategoryOf(p(".obsidian/plugins/dataview/extra/main.js"))).toBeUndefined();
  });
  it("zync's own plugin dir is NEVER in-zone (self-exclusion)", () => {
    expect(isConfigZone(p(".obsidian/plugins/zync/main.js"))).toBe(false);
    expect(isConfigZone(p(".obsidian/plugins/zync/manifest.json"))).toBe(false);
    expect(configCategoryOf(p(".obsidian/plugins/zync/main.js"))).toBeUndefined();
  });
  it("pluginIdOf extracts the id, undefined for non-plugin paths", () => {
    expect(pluginIdOf(p(".obsidian/plugins/dataview/main.js"))).toBe("dataview");
    expect(pluginIdOf(p(".obsidian/themes/Foo/theme.css"))).toBeUndefined();
  });
  it("themes/snippets still classify as before", () => {
    expect(configCategoryOf(p(".obsidian/themes/Foo/theme.css"))).toBe("themes");
    expect(configCategoryOf(p(".obsidian/snippets/x.css"))).toBe("snippets");
    expect(CONFIG_ZONE_PREFIXES).toContain(".obsidian/plugins/");
  });
});

describe("plugin-data category (Slice 3)", () => {
  const p = (s: string) => s as VaultPath;
  it("data.json under a non-zync plugin dir is IN zone, category plugin-data", () => {
    expect(isConfigZone(p(".obsidian/plugins/dataview/data.json"))).toBe(true);
    expect(configCategoryOf(p(".obsidian/plugins/dataview/data.json"))).toBe("plugin-data");
  });
  it("zync's own data.json is NEVER in zone (self-exclusion)", () => {
    expect(isConfigZone(p(".obsidian/plugins/zync/data.json"))).toBe(false);
    expect(configCategoryOf(p(".obsidian/plugins/zync/data.json"))).toBeUndefined();
  });
  it("nested or non-data files under a plugin dir are not plugin-data", () => {
    expect(configCategoryOf(p(".obsidian/plugins/dataview/sub/data.json"))).toBeUndefined();
    expect(configCategoryOf(p(".obsidian/plugins/dataview/cache.json"))).toBeUndefined();
  });
  it("code bundle files keep category plugins (unchanged)", () => {
    expect(configCategoryOf(p(".obsidian/plugins/dataview/main.js"))).toBe("plugins");
  });
});
