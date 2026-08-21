import { pluginSyncPolicy, policySettingsSyncEnabled, type PluginSyncPolicy } from "@zync/core";

export interface PluginSyncPolicyView {
  enabled: boolean;
  overridden: boolean;
  summary: string;
  reason: string;
}

/** Pure settings-row copy and state derived from policy plus an optional explicit CRDT override. */
export function pluginSyncPolicyView(
  id: string,
  explicit: boolean | undefined,
): PluginSyncPolicyView {
  const policy = pluginSyncPolicy(id);
  return pluginSyncPolicyViewForPolicy(policy, explicit);
}

/** Policy-parameterized seam keeps the empty device-local policy class directly testable. */
export function pluginSyncPolicyViewForPolicy(
  policy: PluginSyncPolicy,
  explicit: boolean | undefined,
): PluginSyncPolicyView {
  const defaultEnabled = policySettingsSyncEnabled(policy, undefined);
  const enabled = policySettingsSyncEnabled(policy, explicit);
  const overridden = explicit !== undefined && explicit !== defaultEnabled;

  let summary: string;
  if (overridden)
    summary = enabled
      ? "Settings sync — you changed the default"
      : "Settings not synced — you changed the default";
  else if (policy.kind === "device-local") summary = "Settings not synced by default";
  else if (policy.kind === "sync-except")
    summary =
      policy.deviceLocalKeys.size > 0
        ? "Settings sync; some values stay on this device"
        : "Settings sync; volatile-only changes are not sent";
  else summary = "Settings sync by default";

  return { enabled, overridden, summary, reason: policy.reason };
}
