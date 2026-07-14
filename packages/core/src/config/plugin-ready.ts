import type { VaultPath } from "../ports.js";
import type { ConfigEntry } from "./config-entry.js";
import { pluginIdOf } from "./config-entry.js";

/** The REQUIRED files of a plugin bundle, given any path in the plugin dir. styles.css is optional. */
export function pluginSiblings(path: VaultPath): VaultPath[] {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return [`${dir}/manifest.json`, `${dir}/main.js`] as VaultPath[];
}

/** A plugins path is materializable only when BOTH required siblings (manifest.json + main.js) are live.
 *  Non-plugin paths are always ready. */
export function pluginReady(
  path: VaultPath,
  get: (k: VaultPath) => ConfigEntry | undefined,
): boolean {
  if (pluginIdOf(path) === undefined) return true;
  return pluginSiblings(path).every((s) => {
    const e = get(s);
    return e !== undefined && e.deleted !== true;
  });
}
