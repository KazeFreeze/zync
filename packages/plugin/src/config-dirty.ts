/** The four config-sync category flags (mirrors ZyncSettings.syncConfig). */
export interface SyncConfigFlags {
  themes: boolean;
  snippets: boolean;
  plugins: boolean;
  "plugin-data": boolean;
}

/**
 * True iff the engine's start-time category config differs from the current (saved) one — i.e.
 * a restart is needed to apply. Pure; the settings tab renders a "restart to apply" banner on true.
 */
export function configDirty(started: SyncConfigFlags, current: SyncConfigFlags): boolean {
  return (
    started.themes !== current.themes ||
    started.snippets !== current.snippets ||
    started.plugins !== current.plugins ||
    started["plugin-data"] !== current["plugin-data"]
  );
}
