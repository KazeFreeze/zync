import { describe, it, expect } from "vitest";
import { groupKeyOf, groupMembers } from "./config-group.js";
import type { VaultPath } from "../ports.js";
const p = (s: string) => s as VaultPath;

describe("config-group", () => {
  it("a plugin path groups to its plugin dir", () => {
    expect(groupKeyOf(p(".obsidian/plugins/dv/main.js"))).toBe(".obsidian/plugins/dv/");
    expect(groupKeyOf(p(".obsidian/plugins/dv/manifest.json"))).toBe(".obsidian/plugins/dv/");
  });
  it("a theme path groups to its theme dir (m7)", () => {
    expect(groupKeyOf(p(".obsidian/themes/Foo/theme.css"))).toBe(".obsidian/themes/Foo/");
  });
  it("a snippet path is its own single-file group", () => {
    expect(groupKeyOf(p(".obsidian/snippets/x.css"))).toBe(".obsidian/snippets/x.css");
  });
  it("groupMembers returns all config keys under a dir group", () => {
    const keys = [
      ".obsidian/plugins/dv/manifest.json",
      ".obsidian/plugins/dv/main.js",
      ".obsidian/plugins/dv/styles.css",
      ".obsidian/plugins/other/main.js",
    ];
    expect(groupMembers(".obsidian/plugins/dv/", keys).sort()).toEqual(
      [
        ".obsidian/plugins/dv/main.js",
        ".obsidian/plugins/dv/manifest.json",
        ".obsidian/plugins/dv/styles.css",
      ].sort(),
    );
  });
  it("groupMembers of a single-file group returns just that key", () => {
    expect(groupMembers(".obsidian/snippets/x.css", [".obsidian/snippets/x.css"])).toEqual([
      ".obsidian/snippets/x.css",
    ]);
  });
  it("plugin-data groups as a single file (the path itself), not a dir bundle", () => {
    const path = ".obsidian/plugins/dataview/data.json" as VaultPath;
    expect(groupKeyOf(path)).toBe(path);
  });
});
