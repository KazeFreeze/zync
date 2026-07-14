import { describe, it, expect } from "vitest";
import { pluginSiblings, pluginReady } from "./plugin-ready.js";
import type { ConfigEntry } from "./config-entry.js";
import type { VaultPath } from "../ports.js";
const p = (s: string) => s as VaultPath;
const live: ConfigEntry = {
  sha256: "s" as never,
  size: 1,
  category: "plugins",
  deviceId: "d" as never,
};

describe("plugin-ready", () => {
  it("required siblings are manifest.json + main.js for a plugin path", () => {
    expect(pluginSiblings(p(".obsidian/plugins/dv/main.js")).sort()).toEqual(
      [".obsidian/plugins/dv/main.js", ".obsidian/plugins/dv/manifest.json"].sort(),
    );
  });
  it("not ready until BOTH manifest.json and main.js are live", () => {
    const m = new Map<string, ConfigEntry>([[".obsidian/plugins/dv/main.js", live]]);
    expect(pluginReady(p(".obsidian/plugins/dv/main.js"), (k) => m.get(k))).toBe(false);
    m.set(".obsidian/plugins/dv/manifest.json", live);
    expect(pluginReady(p(".obsidian/plugins/dv/main.js"), (k) => m.get(k))).toBe(true);
  });
  it("styles.css is optional — a bundle with only manifest+main.js is ready", () => {
    const m = new Map<string, ConfigEntry>([
      [".obsidian/plugins/dv/manifest.json", live],
      [".obsidian/plugins/dv/main.js", live],
    ]);
    expect(pluginReady(p(".obsidian/plugins/dv/styles.css"), (k) => m.get(k))).toBe(true);
  });
  it("a tombstoned required sibling makes the bundle not ready", () => {
    const m = new Map<string, ConfigEntry>([
      [".obsidian/plugins/dv/manifest.json", { ...live, deleted: true }],
      [".obsidian/plugins/dv/main.js", live],
    ]);
    expect(pluginReady(p(".obsidian/plugins/dv/main.js"), (k) => m.get(k))).toBe(false);
  });
  it("a non-plugin path is always ready", () => {
    expect(pluginReady(p(".obsidian/snippets/x.css"), () => undefined)).toBe(true);
  });
});
