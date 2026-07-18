/**
 * Pure derivation of a plugin's per-device override state from the two override
 * sets the plugin exposes: device-local suppress (run-here off) and settings-
 * sync-off (settings kept local). No DOM, no Obsidian API — the one unit-
 * testable seam behind the Synced-plugins row UI. The row's deviation chips,
 * the Reset button's visibility, and the tinted chevron all read `deviated`.
 */
export interface OverrideState {
  /** Synced, but kept disabled on THIS device (id ∈ suppress set). */
  suppressed: boolean;
  /** Settings (data.json) NOT synced — kept local per device (id ∈ settings-off set). */
  settingsLocal: boolean;
  /** Any override differs from defaults (run-here on + sync-settings on). */
  deviated: boolean;
}

export function overrideState(
  id: string,
  suppressed: ReadonlySet<string>,
  settingsOff: ReadonlySet<string>,
): OverrideState {
  const isSuppressed = suppressed.has(id);
  const isSettingsLocal = settingsOff.has(id);
  return {
    suppressed: isSuppressed,
    settingsLocal: isSettingsLocal,
    deviated: isSuppressed || isSettingsLocal,
  };
}
