import { describe, it, expect } from "vitest";
import { themeSiblings, themeReady } from "./theme-ready.js";
import type { ConfigEntry } from "./config-entry.js";
import type { VaultPath } from "../ports.js";

const p = (s: string) => s as VaultPath;
const live: ConfigEntry = {
  sha256: "s" as never,
  size: 1,
  category: "themes",
  deviceId: "d" as never,
};

describe("theme-ready", () => {
  it("computes both sibling paths from either file", () => {
    expect(themeSiblings(p(".obsidian/themes/Foo/theme.css")).sort()).toEqual(
      [".obsidian/themes/Foo/manifest.json", ".obsidian/themes/Foo/theme.css"].sort(),
    );
  });
  it("not ready until BOTH siblings are live in the config map", () => {
    const map = new Map<string, ConfigEntry>([[".obsidian/themes/Foo/theme.css", live]]);
    expect(themeReady(p(".obsidian/themes/Foo/theme.css"), (k) => map.get(k))).toBe(false);
    map.set(".obsidian/themes/Foo/manifest.json", live);
    expect(themeReady(p(".obsidian/themes/Foo/theme.css"), (k) => map.get(k))).toBe(true);
  });
  it("a snippet path is always ready (single-file)", () => {
    expect(themeReady(p(".obsidian/snippets/x.css"), () => undefined)).toBe(true);
  });
});
