export type PluginSyncPolicy =
  | { kind: "sync"; reason: string }
  | { kind: "device-local"; reason: string }
  | { kind: "sync-except"; volatileKeys: ReadonlySet<string>; reason: string };

const DEFAULT_POLICY: PluginSyncPolicy = {
  kind: "sync",
  reason: "Stores settings that can be shared across devices.",
};

const POLICIES: Readonly<Record<string, PluginSyncPolicy>> = {
  omnisearch: {
    kind: "sync-except",
    volatileKeys: new Set(["useCache", "DANGER_forceSaveCache", "DANGER_httpHost"]),
    reason: "Stores shared search preferences alongside device-local cache and service settings.",
  },
  tasknotes: {
    kind: "sync-except",
    volatileKeys: new Set([
      "googleCalendarTaskFingerprints",
      "googleCalendarEventIndex",
      "googleCalendarSyncTokens",
      "taskOrgFiltersCollapsed",
    ]),
    reason:
      "Stores shared task preferences alongside device-local calendar cache and interface state.",
  },
  "periodic-notes": {
    kind: "sync-except",
    volatileKeys: new Set(["hasMigratedDailyNoteSettings", "hasMigratedWeeklyNoteSettings"]),
    reason: "Stores shared note schedules alongside device-local migration state.",
  },
};

/** Built-in recommendation for a plugin id. Unknown plugins keep the historical sync default. */
export function pluginSyncPolicy(id: string): PluginSyncPolicy {
  return POLICIES[id] ?? DEFAULT_POLICY;
}

/** Explicit CRDT state wins; only an absent value falls back to the supplied recommendation. */
export function policySettingsSyncEnabled(
  policy: PluginSyncPolicy,
  explicit: boolean | undefined,
): boolean {
  if (explicit !== undefined) return explicit;
  return policy.kind !== "device-local";
}

/** Resolve a plugin id through the built-in table, then apply an optional explicit override. */
export function pluginSettingsSyncEnabled(id: string, explicit: boolean | undefined): boolean {
  return policySettingsSyncEnabled(pluginSyncPolicy(id), explicit);
}
