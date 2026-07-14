/**
 * ObsidianPluginRuntime — PluginRuntimePort implementation around the undocumented
 * `app.plugins` API (enablePlugin/disablePlugin/enabledPlugins).
 *
 * UNDOCUMENTED API POLICY (Slice 2b discipline):
 * - The entire `app.plugins` cast is CONFINED HERE. No `any` leaks to other packages.
 * - Every `enablePlugin`/`disablePlugin` call uses `.catch(() => undefined)` so a missing or
 *   failed internal never throws — degrading silently to "reload to apply" (the restart floor
 *   provided by the community-plugins.json projection is always the guaranteed fallback).
 * - `enabledIds()` is read-only and safe to call at any time.
 */

import type { App } from "obsidian";
import type { PluginRuntimePort } from "@zync/core";

/** The undocumented shape of app.plugins we rely on. */
interface AppPlugins {
  enabledPlugins: Set<string>;
  enablePlugin(id: string): Promise<void>;
  disablePlugin(id: string): Promise<void>;
  /** Undocumented: the live plugin-instance map, keyed by id. */
  plugins: Record<string, { onExternalSettingsChange?: () => unknown } | undefined>;
}

export class ObsidianPluginRuntime implements PluginRuntimePort {
  constructor(private readonly app: App) {}

  /** Access app.plugins, returning undefined when the internal is absent or inaccessible. */
  private get pm(): AppPlugins | undefined {
    return (this.app as unknown as { plugins?: AppPlugins }).plugins;
  }

  enabledIds(): string[] {
    const s = this.pm?.enabledPlugins;
    return s ? [...s] : [];
  }

  async enable(id: string): Promise<void> {
    await this.pm?.enablePlugin(id).catch(() => undefined);
  }

  async disable(id: string): Promise<void> {
    await this.pm?.disablePlugin(id).catch(() => undefined);
  }

  async applyExternalSettings(id: string): Promise<boolean> {
    try {
      const inst = this.pm?.plugins[id];
      const hook = inst?.onExternalSettingsChange;
      if (typeof hook !== "function") return false;
      await Promise.resolve(hook.call(inst)); // plugin re-reads its data.json live
      return true;
    } catch {
      return false; // degrade → caller stages a reload
    }
  }
}
