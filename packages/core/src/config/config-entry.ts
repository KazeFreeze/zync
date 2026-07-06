import type { DeviceId, Sha256, VaultPath } from "../ports.js";

export type ConfigCategory = "themes" | "snippets";

/** One row of the index `config` map: a content-addressed config file at a vault path. */
export interface ConfigEntry {
  sha256: Sha256;
  size: number;
  category: ConfigCategory;
  deviceId: DeviceId;
  deleted?: boolean;
  /** RESERVED for Slice 3 (data.json version-gating); unused for themes/snippets. */
  version?: string;
}

/** The slice-1 config zone: an explicit allow-list, NOT "all of .obsidian minus exclusions". */
export const CONFIG_ZONE_PREFIXES = [".obsidian/themes/", ".obsidian/snippets/"] as const;

export function isConfigZone(path: VaultPath): boolean {
  return CONFIG_ZONE_PREFIXES.some((pre) => path.startsWith(pre));
}

export function configCategoryOf(path: VaultPath): ConfigCategory | undefined {
  if (path.startsWith(".obsidian/themes/")) return "themes";
  if (path.startsWith(".obsidian/snippets/")) return "snippets";
  return undefined;
}
