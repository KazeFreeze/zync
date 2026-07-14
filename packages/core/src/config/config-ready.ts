import type { VaultPath } from "../ports.js";
import type { ConfigEntry } from "./config-entry.js";
import { configCategoryOf } from "./config-entry.js";
import { themeReady, themeSiblings } from "./theme-ready.js";
import { pluginReady, pluginSiblings } from "./plugin-ready.js";

/** Extra sibling paths whose changes must re-check this path's readiness (for RoutedManifest.observe). */
export function configSiblings(path: VaultPath): VaultPath[] {
  const c = configCategoryOf(path);
  if (c === "themes") return themeSiblings(path);
  if (c === "plugins") return pluginSiblings(path);
  // "plugin-data" is single-file -> default []
  return [];
}

/** Category-dispatched multi-file readiness. Single-file categories (snippets, plugin-data) are always ready. */
export function configReady(
  path: VaultPath,
  get: (k: VaultPath) => ConfigEntry | undefined,
): boolean {
  const c = configCategoryOf(path);
  if (c === "themes") return themeReady(path, get);
  if (c === "plugins") return pluginReady(path, get);
  // "plugin-data" is single-file -> ready
  return true;
}
