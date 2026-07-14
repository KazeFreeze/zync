import type { CrdtMap, Unsubscribe, VaultPath } from "../ports.js";
import { pluginIdOf, isPluginDataPath } from "./config-entry.js";

/** Shared per-plugin metadata, written by the opting-in device from its local manifest. */
export interface PluginMeta {
  isDesktopOnly: boolean;
}

/** Pure gate: a plugin path is allowed iff opted-in AND platform-allowed. Non-plugin paths always pass. */
export class PluginGate {
  constructor(
    private readonly optIn: CrdtMap<boolean>,
    private readonly meta: CrdtMap<PluginMeta>,
    private readonly isMobile: boolean,
    /** Slice 3: per-plugin settings-sync toggle (default ON: absent = sync). Consulted only for data paths. */
    private readonly settingsSync?: CrdtMap<boolean>,
  ) {}

  platformAllowed(id: string): boolean {
    if (!this.isMobile) return true;
    return this.meta.get(id)?.isDesktopOnly !== true;
  }

  allows(path: VaultPath): boolean {
    const id = pluginIdOf(path);
    if (id === undefined) return true; // not a plugin path — gate is transparent
    if (isPluginDataPath(path) && this.settingsSync?.get(id) === false) return false; // S3-2 off-switch
    return this.optIn.get(id) === true && this.platformAllowed(id);
  }

  /**
   * Subscribe to opt-in / meta changes. The changed KEYS are plugin ids (both maps are
   * keyed by plugin id), so consumers can map an id back to its config bundle paths and
   * re-check readiness — making materialization order-independent (an opt-in that arrives
   * AFTER the config entries were already observed still triggers a re-materialization).
   */
  observe(cb: (changedPluginIds: string[]) => void): Unsubscribe {
    const subs = [this.optIn.observe(cb), this.meta.observe(cb)];
    if (this.settingsSync !== undefined) subs.push(this.settingsSync.observe(cb));
    return () => {
      for (const u of subs) u();
    };
  }
}
