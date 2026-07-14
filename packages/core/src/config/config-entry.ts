import type { DeviceId, Sha256, VaultPath } from "../ports.js";

export type ConfigCategory = "themes" | "snippets" | "plugins" | "plugin-data";

/** One row of the index `config` map: a content-addressed config file at a vault path. */
export interface ConfigEntry {
  sha256: Sha256;
  size: number;
  category: ConfigCategory;
  deviceId: DeviceId;
  deleted?: boolean;
  /** RESERVED for Slice 3 (data.json version-gating); unused for themes/snippets. */
  version?: string;
  /**
   * plugin-data ONLY: a Lamport-style per-path edit counter used to order concurrent settings
   * edits by recency (a newer edit has a higher number). Absent ⇒ treat as `0` (back-compat: a
   * versionless entry from a pre-upgrade device is compared as version 0). Distinct from `version`
   * above (which is the plugin's manifest/code semver used by PluginDataVersionGate).
   */
  dataVersion?: number;
}

/** The config zone: theme/snippet whole-prefix + a FILE-ALLOW-LISTED plugin arm. */
export const CONFIG_ZONE_PREFIXES = [
  ".obsidian/themes/",
  ".obsidian/snippets/",
  ".obsidian/plugins/",
] as const;

/** Path to the community-plugins enabled list; managed by CommunityPluginsPort, excluded from prose vault. */
export const COMMUNITY_PLUGINS_PATH = ".obsidian/community-plugins.json";

/** Files that make up a syncable plugin code bundle. data.json is EXCLUDED (Slice 3). */
export const PLUGIN_BUNDLE_FILES = ["manifest.json", "main.js", "styles.css"] as const;

const ZYNC_PLUGIN_ID = "zync";

/** Plugin id for a `.obsidian/plugins/<id>/...` path, else undefined. */
export function pluginIdOf(path: VaultPath): string | undefined {
  const m = /^\.obsidian\/plugins\/([^/]+)\//.exec(path);
  return m === null ? undefined : m[1];
}

/** True ONLY for an allow-listed bundle file DIRECTLY under a non-zync plugin dir (no nesting). */
function isPluginBundlePath(path: VaultPath): boolean {
  const id = pluginIdOf(path);
  if (id === undefined || id === ZYNC_PLUGIN_ID) return false;
  const rest = path.slice(`.obsidian/plugins/${id}/`.length);
  return !rest.includes("/") && (PLUGIN_BUNDLE_FILES as readonly string[]).includes(rest);
}

/** True ONLY for `data.json` DIRECTLY under a non-zync plugin dir (no nesting). Slice 3. */
export function isPluginDataPath(path: VaultPath): boolean {
  const id = pluginIdOf(path);
  if (id === undefined || id === ZYNC_PLUGIN_ID) return false;
  return path.slice(`.obsidian/plugins/${id}/`.length) === "data.json";
}

export function isConfigZone(path: VaultPath): boolean {
  if (path.startsWith(".obsidian/themes/") || path.startsWith(".obsidian/snippets/")) return true;
  return isPluginBundlePath(path) || isPluginDataPath(path);
}

export function configCategoryOf(path: VaultPath): ConfigCategory | undefined {
  if (path.startsWith(".obsidian/themes/")) return "themes";
  if (path.startsWith(".obsidian/snippets/")) return "snippets";
  if (isPluginBundlePath(path)) return "plugins";
  if (isPluginDataPath(path)) return "plugin-data";
  return undefined;
}
