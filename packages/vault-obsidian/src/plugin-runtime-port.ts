/**
 * ObsidianPluginRuntime — PluginRuntimePort implementation around the undocumented
 * `app.plugins` API (enablePlugin/disablePlugin/enabledPlugins).
 *
 * UNDOCUMENTED API POLICY (Slice 2b discipline):
 * - The entire `app.plugins` cast is CONFINED HERE. No `any` leaks to other packages.
 * - enable/disable REJECT when the internal is missing or the call fails. Swallowing used to
 *   report success while nothing ran, so the reconciler exited after five "successful" rounds
 *   with the plugin still wrong and the user told nothing. The restart floor
 *   (community-plugins.json) is still the fallback — callers must surface it when live apply
 *   fails, not pretend the apply worked.
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
    const pm = this.pm;
    if (pm === undefined || typeof pm.enablePlugin !== "function") {
      throw new Error("Obsidian plugin API unavailable (enablePlugin)");
    }
    await pm.enablePlugin(id);
    // Optional-chaining used to resolve `undefined` as success. Verify the set flipped, so a
    // no-op "success" cannot look like an apply to the reconciler.
    if (!pm.enabledPlugins.has(id)) {
      throw new Error(`enablePlugin(${id}) did not activate the plugin`);
    }
  }

  async disable(id: string): Promise<void> {
    const pm = this.pm;
    if (pm === undefined || typeof pm.disablePlugin !== "function") {
      throw new Error("Obsidian plugin API unavailable (disablePlugin)");
    }
    await pm.disablePlugin(id);
    if (pm.enabledPlugins.has(id)) {
      throw new Error(`disablePlugin(${id}) did not deactivate the plugin`);
    }
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
