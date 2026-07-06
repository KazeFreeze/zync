import { describe, it, expect } from "vitest";
import { CONFIG_ZONE_PREFIXES, isConfigZone, configCategoryOf } from "./config-entry.js";
import type { VaultPath } from "../ports.js";

const p = (s: string) => s as VaultPath;

describe("config-entry zone helpers", () => {
  it("themes + snippets prefixes are the config zone", () => {
    expect(CONFIG_ZONE_PREFIXES).toEqual([".obsidian/themes/", ".obsidian/snippets/"]);
  });
  it("isConfigZone matches themes/snippets only", () => {
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
