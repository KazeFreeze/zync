/**
 * Pure decision for whether a failed live plugin enable/disable still has a restart floor.
 *
 * Live apply (app.plugins) is best-effort; community-plugins.json is the guaranteed restart
 * floor. When BOTH miss, a silent "success" is worse than an error — the user must be told.
 */

export type PluginApplyOutcome =
  | { kind: "live-ok" }
  | {
      kind: "reload-needed";
      /** True when the restart-floor write holds the desired state even though live apply failed. */
      floorOk: boolean;
      title: string;
      detail: string;
    };

/**
 * Decide what to tell the user after a live enable/disable did not take effect.
 *
 * @param wantEnabled - desired running state after the apply
 * @param floorHasId - whether community-plugins.json currently lists the plugin id
 */
export function pluginApplyFailureNotice(
  pluginId: string,
  wantEnabled: boolean,
  floorHasId: boolean,
): PluginApplyOutcome {
  // Floor matches desire: restart will apply. Live apply failed but the promise is kept.
  const floorOk = wantEnabled === floorHasId;
  if (floorOk) {
    return {
      kind: "reload-needed",
      floorOk: true,
      title: "Reload required",
      detail: `Could not live-apply ${pluginId}. Restart Obsidian to finish applying the change.`,
    };
  }
  // Neither live apply nor the restart-floor write landed — silence here was the bug.
  return {
    kind: "reload-needed",
    floorOk: false,
    title: "Could not apply",
    detail: `Could not enable/disable ${pluginId}, and the restart fallback did not save either. Reload Obsidian and check plugin settings.`,
  };
}
