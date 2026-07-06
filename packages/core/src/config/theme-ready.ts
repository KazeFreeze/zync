import type { VaultPath } from "../ports.js";
import type { ConfigEntry } from "./config-entry.js";

/** The two files that make up a theme, given either one. */
export function themeSiblings(path: VaultPath): VaultPath[] {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return [`${dir}/theme.css`, `${dir}/manifest.json`] as VaultPath[];
}

/** A themes-category path is materializable only when BOTH siblings are live (non-deleted) in the
 *  config map. Non-themes paths (snippets) are always ready. */
export function themeReady(
  path: VaultPath,
  get: (k: VaultPath) => ConfigEntry | undefined,
): boolean {
  if (!path.startsWith(".obsidian/themes/")) return true;
  return themeSiblings(path).every((s) => {
    const e = get(s);
    return e !== undefined && e.deleted !== true;
  });
}
