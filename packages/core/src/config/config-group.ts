import type { VaultPath } from "../ports.js";
import { configCategoryOf } from "./config-entry.js";

/** The conflict-resolution unit for a config path: a dir (multi-file bundle) or the path itself. */
export function groupKeyOf(path: VaultPath): string {
  const c = configCategoryOf(path);
  if (c === "themes" || c === "plugins") return path.slice(0, path.lastIndexOf("/") + 1);
  // "plugin-data" is intentionally single-file -> falls to `return path`
  return path; // snippets + anything single-file
}

/** All config-map keys belonging to a group. Dir groups end with "/"; single-file groups are exact. */
export function groupMembers(groupKey: string, keys: Iterable<string>): string[] {
  if (!groupKey.endsWith("/")) return [groupKey];
  const out: string[] = [];
  for (const k of keys) if (k.startsWith(groupKey)) out.push(k);
  return out;
}
