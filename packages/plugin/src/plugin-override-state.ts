import { pluginSyncPolicyView, type PluginSyncPolicyView } from "./plugin-sync-policy-view.js";

/**
 * Pure derivation of a plugin's per-device override state from device-local suppress and the
 * optional shared settings-sync override. No DOM, no Obsidian API — the one unit-
 * testable seam behind the Synced-plugins row UI. The row's deviation chips,
 * the Reset button's visibility, and the tinted chevron all read `deviated`.
 */
export interface OverrideState {
  /** Synced, but kept disabled on THIS device (id ∈ suppress set). */
  suppressed: boolean;
  /** Effective policy keeps settings (data.json) local on this device. */
  settingsLocal: boolean;
  /** Effective settings policy and user-facing explanation for this plugin. */
  settingsPolicy: PluginSyncPolicyView;
  /** Run-here or settings-sync state differs from its default. */
  deviated: boolean;
}

export function overrideState(
  id: string,
  suppressed: ReadonlySet<string>,
  settingsOverrides: ReadonlyMap<string, boolean>,
): OverrideState {
  const isSuppressed = suppressed.has(id);
  const settingsPolicy = pluginSyncPolicyView(id, settingsOverrides.get(id));
  return {
    suppressed: isSuppressed,
    settingsLocal: !settingsPolicy.enabled,
    settingsPolicy,
    deviated: isSuppressed || settingsPolicy.overridden,
  };
}
