import { describe, it, expect } from "vitest";
import { configDirty, type SyncConfigFlags } from "./config-dirty.js";

const cfg = (o: Partial<SyncConfigFlags> = {}): SyncConfigFlags => ({
  themes: false,
  snippets: false,
  plugins: false,
  "plugin-data": false,
  ...o,
});

describe("configDirty", () => {
  it("false when all four flags match", () => {
    expect(configDirty(cfg(), cfg())).toBe(false);
    expect(configDirty(cfg({ plugins: true }), cfg({ plugins: true }))).toBe(false);
  });
  it("true when the plugins flag differs", () => {
    expect(configDirty(cfg({ plugins: false }), cfg({ plugins: true }))).toBe(true);
  });
  it("true when plugin-data differs", () => {
    expect(configDirty(cfg(), cfg({ "plugin-data": true }))).toBe(true);
  });
  it("true when themes or snippets differ", () => {
    expect(configDirty(cfg(), cfg({ themes: true }))).toBe(true);
    expect(configDirty(cfg(), cfg({ snippets: true }))).toBe(true);
  });
});
