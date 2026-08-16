import { describe, it, expect } from "vitest";
import { ObsidianPluginRuntime } from "./plugin-runtime-port.js";
import type { App } from "obsidian";

/**
 * enable/disable used to optional-chain + catch-all, so a missing API resolved as success and the
 * reconciler exited after five silent "ok" rounds. They must reject so the caller can surface
 * reload-required honestly.
 */
describe("ObsidianPluginRuntime enable/disable honesty", () => {
  it("rejects enable when app.plugins is absent", async () => {
    const rt = new ObsidianPluginRuntime({} as App);
    await expect(rt.enable("dataview")).rejects.toThrow(/unavailable/i);
  });

  it("rejects disable when app.plugins is absent", async () => {
    const rt = new ObsidianPluginRuntime({} as App);
    await expect(rt.disable("dataview")).rejects.toThrow(/unavailable/i);
  });

  it("rejects enable when enablePlugin resolves but the plugin stays inactive", async () => {
    const enabledPlugins = new Set<string>();
    const app = {
      plugins: {
        enabledPlugins,
        enablePlugin: () => Promise.resolve(undefined), // "succeeds" without adding
        disablePlugin: () => Promise.resolve(undefined),
        plugins: {},
      },
    } as unknown as App;
    const rt = new ObsidianPluginRuntime(app);
    await expect(rt.enable("dataview")).rejects.toThrow(/did not activate/i);
  });

  it("resolves enable when the plugin lands in enabledPlugins", async () => {
    const enabledPlugins = new Set<string>();
    const app = {
      plugins: {
        enabledPlugins,
        enablePlugin: (id: string) => {
          enabledPlugins.add(id);
          return Promise.resolve();
        },
        disablePlugin: (id: string) => {
          enabledPlugins.delete(id);
          return Promise.resolve();
        },
        plugins: {},
      },
    } as unknown as App;
    const rt = new ObsidianPluginRuntime(app);
    await rt.enable("dataview");
    expect(rt.enabledIds()).toContain("dataview");
  });
});
