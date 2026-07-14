import { describe, it, expect } from "vitest";
import { compareVersions, PluginDataVersionGate } from "./plugin-data-gate.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import type { ConfigEntry } from "./config-entry.js";
import type { VaultPath } from "../ports.js";

const dataPath = ".obsidian/plugins/dv/data.json" as VaultPath;

const PD = (version?: string): ConfigEntry => ({
  sha256: "aa" as never,
  size: 3,
  category: "plugin-data",
  deviceId: "d" as never,
  ...(version !== undefined ? { version } : {}),
});

describe("compareVersions", () => {
  it("compares dotted-numeric segments numerically (1.2.0 < 1.10.0)", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
  });
  it("2.0.0 > 1.9.9", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });
  it("equal versions compare to 0", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  it("missing version is lowest", () => {
    expect(compareVersions(undefined, "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", undefined)).toBeGreaterThan(0);
    expect(compareVersions(undefined, undefined)).toBe(0);
  });
  it("a prerelease is LOWER than the same core release (semver)", () => {
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2.0-alpha")).toBeGreaterThan(0);
  });
  it("orders prereleases against each other by suffix", () => {
    expect(compareVersions("1.2.3-beta", "1.2.3-rc")).toBeLessThan(0);
  });
  it("parses segments as STRICT integers ('1e2' is not 100)", () => {
    // Number('1e2') === 100 would make these equal; strict /^\d+$/ must NOT.
    expect(compareVersions("1e2.0", "100.0")).not.toBe(0);
  });
});

describe("PluginDataVersionGate", () => {
  it("holds when writer is strictly newer than local", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, PD("2.0.0"));
    const gate = new PluginDataVersionGate({
      config,
      localVersion: async () => "1.0.0",
    });
    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(true);
  });

  it("releases (and fires observe) once the local version catches up", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, PD("2.0.0"));
    let local: string | undefined = "1.0.0";
    const gate = new PluginDataVersionGate({
      config,
      localVersion: async () => local,
    });
    const seen: string[][] = [];
    gate.observe((keys) => seen.push([...keys]));

    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(true);
    expect(seen).toHaveLength(0);

    local = "2.0.0";
    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(dataPath);
  });

  it("holds when the plugin code is not installed locally (undefined)", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, PD("1.0.0"));
    const gate = new PluginDataVersionGate({
      config,
      localVersion: async () => undefined,
    });
    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(true);
  });

  it("does NOT hold when writer is older than local (older-onto-newer applies)", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, PD("1.0.0"));
    const gate = new PluginDataVersionGate({
      config,
      localVersion: async () => "2.0.0",
    });
    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(false);
  });

  it("reeval() with no ids evaluates ALL plugin-data entries", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, PD("2.0.0"));
    config.set(".obsidian/plugins/other/data.json" as VaultPath, PD("2.0.0"));
    const gate = new PluginDataVersionGate({
      config,
      localVersion: async () => "1.0.0",
    });
    await gate.reeval();
    expect(gate.blocks(dataPath)).toBe(true);
    expect(gate.blocks(".obsidian/plugins/other/data.json" as VaultPath)).toBe(true);
  });

  it("ignores deleted plugin-data entries", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, { ...PD("2.0.0"), deleted: true });
    const gate = new PluginDataVersionGate({
      config,
      localVersion: async () => "1.0.0",
    });
    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(false);
  });

  it("serializes concurrent reevals: a stale run cannot re-hold a just-released path", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, PD("2.0.0"));
    // Instrument localVersion: record call ordering (proves NO overlap) + drive the version by call.
    const active: string[] = [];
    const order: string[] = [];
    // First reeval sees the OLD local (holds); second sees the UPGRADED local (releases).
    const versions = ["1.0.0", "2.0.0"];
    let call = 0;
    let firstResolve: (() => void) | undefined;
    const firstGate = new Promise<void>((r) => (firstResolve = r));
    const gate = new PluginDataVersionGate({
      config,
      localVersion: async () => {
        const label = `call${call}`;
        // No two localVersion bodies may be in-flight at once if reeval is serialized.
        expect(active).toHaveLength(0);
        active.push(label);
        order.push(label);
        const v = versions[call] ?? "2.0.0";
        call += 1;
        // Make the FIRST (stale) call resolve slowly so, WITHOUT serialization, the 2nd would
        // finish first (releasing) and the 1st would then wrongly re-hold.
        if (label === "call0") await firstGate;
        active.pop();
        return v;
      },
    });

    const p1 = gate.reeval(["dv"]); // stale run: local 1.0.0 -> would hold
    const p2 = gate.reeval(["dv"]); // fresh run: local 2.0.0 -> should release
    firstResolve?.();
    await Promise.all([p1, p2]);

    // Serialized => call0 fully completed before call1 began, and the final verdict is the fresh one.
    expect(order).toEqual(["call0", "call1"]);
    expect(gate.blocks(dataPath)).toBe(false);
  });

  it("prunes a held path once its entry is tombstoned/removed (no lingering hold)", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, PD("2.0.0"));
    const gate = new PluginDataVersionGate({
      config,
      localVersion: async () => "1.0.0", // holds
    });
    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(true);

    // The plugin-data entry is tombstoned; a reeval scoped to its id must drop the stale hold.
    config.set(dataPath, { ...PD("2.0.0"), deleted: true });
    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(false);
  });

  it("holdPaths holds a plugin-data path synchronously (structural, pre-reeval)", () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    const gate = new PluginDataVersionGate({ config, localVersion: async () => "1.0.0" });
    gate.holdPaths([dataPath]);
    expect(gate.blocks(dataPath)).toBe(true); // held immediately, before any reeval await
  });

  it("holdPaths ignores non-plugin-data paths (never hides themes/snippets)", () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    const gate = new PluginDataVersionGate({ config, localVersion: async () => "1.0.0" });
    gate.holdPaths([".obsidian/snippets/x.css"]);
    expect(gate.blocks(".obsidian/snippets/x.css" as VaultPath)).toBe(false);
  });

  it("reeval RELEASES a pessimistically-held path whose version is adequate", async () => {
    const config = new FakeCrdtMap<ConfigEntry>();
    config.set(dataPath, PD("1.0.0")); // writer v1
    const gate = new PluginDataVersionGate({ config, localVersion: async () => "1.0.0" }); // local v1 (adequate)
    gate.holdPaths([dataPath]);
    expect(gate.blocks(dataPath)).toBe(true);
    await gate.reeval(["dv"]);
    expect(gate.blocks(dataPath)).toBe(false); // released (v1 <= v1)
  });
});
