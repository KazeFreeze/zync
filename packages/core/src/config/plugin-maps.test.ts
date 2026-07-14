import { describe, it, expect } from "vitest";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { PluginGate, type PluginMeta } from "./plugin-maps.js";
import type { VaultPath } from "../ports.js";
const p = (s: string) => s as VaultPath;

function gate(isMobile: boolean) {
  const optIn = new FakeCrdtMap<boolean>();
  const meta = new FakeCrdtMap<PluginMeta>();
  return { optIn, meta, g: new PluginGate(optIn, meta, isMobile) };
}

const code = (id: string) => `.obsidian/plugins/${id}/main.js` as VaultPath;
const data = (id: string) => `.obsidian/plugins/${id}/data.json` as VaultPath;

function gateWithSettings(
  optIn: [string, boolean][],
  settings: [string, boolean][] = [],
) {
  const o = new FakeCrdtMap<boolean>();
  for (const [k, v] of optIn) o.set(k, v);
  const s = new FakeCrdtMap<boolean>();
  for (const [k, v] of settings) s.set(k, v);
  return new PluginGate(o, new FakeCrdtMap<PluginMeta>(), false, s);
}

describe("PluginGate", () => {
  it("blocks a non-opted-in plugin path", () => {
    const { g } = gate(false);
    expect(g.allows(p(".obsidian/plugins/dv/main.js"))).toBe(false);
  });
  it("allows an opted-in plugin on desktop", () => {
    const { optIn, g } = gate(false);
    optIn.set("dv", true);
    expect(g.allows(p(".obsidian/plugins/dv/main.js"))).toBe(true);
  });
  it("blocks a desktop-only plugin on mobile even when opted-in", () => {
    const { optIn, meta, g } = gate(true);
    optIn.set("dv", true);
    meta.set("dv", { isDesktopOnly: true });
    expect(g.allows(p(".obsidian/plugins/dv/main.js"))).toBe(false);
  });
  it("allows a desktop-only plugin on DESKTOP", () => {
    const { optIn, meta, g } = gate(false);
    optIn.set("dv", true);
    meta.set("dv", { isDesktopOnly: true });
    expect(g.allows(p(".obsidian/plugins/dv/main.js"))).toBe(true);
  });
  it("non-plugin paths are always allowed (gate only governs plugins)", () => {
    const { g } = gate(true);
    expect(g.allows(p(".obsidian/themes/Foo/theme.css"))).toBe(true);
    expect(g.allows(p(".obsidian/snippets/x.css"))).toBe(true);
  });
  it("optIn=false explicitly blocks", () => {
    const { optIn, g } = gate(false);
    optIn.set("dv", false);
    expect(g.allows(p(".obsidian/plugins/dv/main.js"))).toBe(false);
  });
});

describe("PluginGate — settingsSync (Slice 3)", () => {
  it("data path allowed when opted-in and settingsSync absent (default ON)", () => {
    expect(gateWithSettings([["dv", true]]).allows(data("dv"))).toBe(true);
  });
  it("data path denied when settingsSync=false, but CODE path still allowed", () => {
    const g = gateWithSettings([["dv", true]], [["dv", false]]);
    expect(g.allows(data("dv"))).toBe(false);
    expect(g.allows(code("dv"))).toBe(true);
  });
  it("data path denied when not opted-in regardless of settingsSync", () => {
    expect(
      gateWithSettings([["dv", false]], [["dv", true]]).allows(data("dv")),
    ).toBe(false);
  });
});
