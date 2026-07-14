import type { CrdtMap, Unsubscribe, VaultPath } from "../ports.js";
import type { ConfigEntry } from "./config-entry.js";
import { configCategoryOf, pluginIdOf } from "./config-entry.js";

/** Split a version into its core and an optional `-prerelease` suffix. */
function splitPre(v: string): [string, string | undefined] {
  const i = v.indexOf("-");
  return i === -1 ? [v, undefined] : [v.slice(0, i), v.slice(i + 1)];
}

/** Compare dotted cores; STRICT integer segments (`/^\d+$/`), non-numeric fall back to string compare. */
function compareCore(a: string, b: string): number {
  const pa = a.split("."),
    pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? "0",
      sb = pb[i] ?? "0";
    const na = /^\d+$/.test(sa) ? Number(sa) : NaN;
    const nb = /^\d+$/.test(sb) ? Number(sb) : NaN;
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = sa.localeCompare(sb);
      if (c !== 0) return c;
    } else if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Compare dotted-numeric versions. Segments are parsed as STRICT integers (`"1e2"` is NOT 100);
 * non-numeric segments fall back to string compare. A `-prerelease` suffix is LOWER than the same
 * core release (semver: `1.2.3-beta < 1.2.3`). Missing (undefined) = lowest.
 */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const [ca, preA] = splitPre(a);
  const [cb, preB] = splitPre(b);
  const core = compareCore(ca, cb);
  if (core !== 0) return core;
  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1; // a is release, b is prerelease -> a newer
  if (preB === undefined) return -1;
  return preA.localeCompare(preB);
}

export interface PluginDataVersionGateDeps {
  config: CrdtMap<ConfigEntry>;
  /** Reads the plugin's LOCAL installed manifest version (from disk); undefined if not installed. */
  localVersion(id: string): Promise<string | undefined>;
}

/**
 * Holds a plugin-data entry when the writer's plugin version is NEWER than the local install (or the local
 * code isn't installed yet). Synchronous `blocks` for RoutedManifest; async `reeval` maintains the held set.
 * A release fires `observe` so RoutedManifest re-emits and the normal materialize path runs (D4-safe).
 */
export class PluginDataVersionGate {
  private readonly held = new Set<VaultPath>();
  private readonly cbs = new Set<(keys: string[]) => void>();
  // Serializes reeval so two concurrent async runs can't interleave at `await localVersion` and
  // let a stale run wrongly re-hold a just-released path.
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly d: PluginDataVersionGateDeps) {}

  blocks(path: VaultPath): boolean {
    return this.held.has(path);
  }

  /**
   * Synchronously hold the given plugin-data paths (pessimistic). Called the instant a config-map entry
   * changes, BEFORE the async reeval computes the verdict, so a materialize in the same tick cannot fetch+write
   * a version-newer data.json before it is evaluated. reeval() releases any path whose version turns out OK.
   * Only plugin-data paths are ever added (holding a themes/snippets path would wrongly hide it from materialize).
   */
  holdPaths(paths: readonly string[]): void {
    for (const p of paths)
      if (configCategoryOf(p as VaultPath) === "plugin-data") this.held.add(p as VaultPath);
  }

  observe(cb: (keys: string[]) => void): Unsubscribe {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  /** Recompute the held set for the given plugin ids (or ALL plugin-data entries when omitted). */
  reeval(ids?: string[]): Promise<void> {
    const next = this.chain.then(() => this.#reevalNow(ids));
    // Swallow rejection for the chain link so one failure doesn't poison the queue; the caller
    // still sees it via `next`.
    this.chain = next.catch(() => undefined);
    return next;
  }

  async #reevalNow(ids?: string[]): Promise<void> {
    const targets = new Map<string, VaultPath[]>();
    for (const [k, e] of this.d.config.entries()) {
      if (e.category !== "plugin-data" || e.deleted === true) continue;
      const id = pluginIdOf(k as VaultPath);
      if (id === undefined || (ids !== undefined && !ids.includes(id))) continue;
      let arr = targets.get(id);
      if (arr === undefined) {
        arr = [];
        targets.set(id, arr);
      }
      arr.push(k as VaultPath);
    }
    const released: string[] = [];
    for (const [id, paths] of targets) {
      const local = await this.d.localVersion(id);
      for (const p of paths) {
        const writer = this.d.config.get(p)?.version;
        // HOLD if local code not installed (undefined) OR writer strictly newer than local.
        const hold = local === undefined || compareVersions(writer, local) > 0;
        if (hold) this.held.add(p);
        else if (this.held.delete(p)) released.push(p);
      }
    }
    // Prune any held path (within the evaluated id scope) whose entry has since become
    // tombstoned/removed/non-plugin-data — otherwise it lingers in `held` forever. These are
    // NOT releases (the file is gone), so they don't fire observe.
    for (const p of [...this.held]) {
      const pid = pluginIdOf(p);
      if (pid === undefined || (ids !== undefined && !ids.includes(pid))) continue;
      const e = this.d.config.get(p);
      if (e === undefined || e.deleted === true || e.category !== "plugin-data") this.held.delete(p);
    }
    if (released.length > 0) for (const cb of this.cbs) cb(released);
  }
}
