import type { CrdtMap, Unsubscribe, VaultPath } from "../ports.js";
import type { BlobManifestEntry } from "../blobs/blob-engine.js";
import type { ConfigEntry } from "./config-entry.js";
import { isConfigZone, configCategoryOf } from "./config-entry.js";
import { configReady, configSiblings } from "./config-ready.js";

/**
 * Unions the index `blobs` + `config` maps into ONE CrdtMap<BlobManifestEntry> for a single
 * BlobEngine. Reads/writes route by the config-zone prefix; config tombstones are filtered so the
 * fetch queue never materializes a deleted file. Keys are disjoint (config under `.obsidian/`,
 * blobs are vault content), so entries()/observe() merge without collision.
 */
export class RoutedManifest implements CrdtMap<BlobManifestEntry> {
  private readonly cats: { themes: boolean; snippets: boolean; plugins?: boolean; "plugin-data"?: boolean };

  constructor(
    private readonly blobs: CrdtMap<BlobManifestEntry>,
    private readonly config: CrdtMap<ConfigEntry>,
    enabledCategories?: { themes: boolean; snippets: boolean; plugins?: boolean; "plugin-data"?: boolean },
    private readonly gate?: {
      allows(path: VaultPath): boolean;
      observe?(cb: (changedPluginIds: string[]) => void): Unsubscribe;
    },
    private readonly versionGate?: {
      blocks(p: VaultPath): boolean;
      observe(cb: (k: string[]) => void): Unsubscribe;
    },
  ) {
    this.cats = {
      themes: enabledCategories?.themes ?? true,
      snippets: enabledCategories?.snippets ?? true,
      // Plugins stay OFF until the opt-in gate is wired (later task); back-compat callers get no plugins.
      plugins: enabledCategories?.plugins ?? false,
      "plugin-data": enabledCategories?.["plugin-data"] ?? false, // back-compat OFF; headless/plugin opt in
    };
  }

  /** Returns true when this device materializes files in the given key's config category. */
  private categoryEnabled(key: string): boolean {
    const c = configCategoryOf(key as VaultPath);
    return c !== undefined && this.cats[c] === true;
  }

  get(key: string): BlobManifestEntry | undefined {
    if (isConfigZone(key as never)) {
      if (!this.categoryEnabled(key)) return undefined;
      if (this.gate !== undefined && !this.gate.allows(key as VaultPath)) return undefined;
      const e = this.config.get(key);
      if (e === undefined || e.deleted === true) return undefined;
      if (!configReady(key as VaultPath, (k) => this.config.get(k))) return undefined;
      if (this.versionGate?.blocks(key as VaultPath) === true) return undefined;
      return { sha256: e.sha256, size: e.size, deviceId: e.deviceId };
    }
    return this.blobs.get(key);
  }

  set(key: string, value: BlobManifestEntry): void {
    // Config writes go through ConfigChannel.publish (which carries category); this path is
    // BLOB-only in practice. Route defensively so a config key never lands in the blobs map.
    if (isConfigZone(key as never))
      throw new Error(`RoutedManifest.set: config path must publish via ConfigChannel: ${key}`);
    this.blobs.set(key, value);
  }

  delete(key: string): void {
    if (isConfigZone(key as never)) this.config.delete(key);
    else this.blobs.delete(key);
  }

  entries(): [string, BlobManifestEntry][] {
    const out: [string, BlobManifestEntry][] = this.blobs.entries();
    for (const [k, e] of this.config.entries()) {
      if (!this.categoryEnabled(k)) continue;
      if (this.gate !== undefined && !this.gate.allows(k as VaultPath)) continue;
      if (e.deleted === true) continue;
      if (!configReady(k as VaultPath, (kk) => this.config.get(kk))) continue;
      if (this.versionGate?.blocks(k as VaultPath) === true) continue;
      out.push([k, { sha256: e.sha256, size: e.size, deviceId: e.deviceId }]);
    }
    return out;
  }

  /**
   * Fan `blobs` + `config` changes to `cb`. ALSO re-emits a plugin's config keys when its
   * opt-in / meta state changes (via `gate.observe`), so a bundle materializes ORDER-INDEPENDENTLY:
   * an opt-in that arrives AFTER the config entries were already observed still re-triggers
   * materialization (without it, the gated-out bundle would stay hidden until an unrelated
   * config change or a restart).
   */
  observe(cb: (changedKeys: string[]) => void): Unsubscribe {
    const expand = (keys: string[]): string[] => {
      const set = new Set<string>(keys);
      for (const k of keys) for (const s of configSiblings(k as VaultPath)) set.add(s);
      return [...set];
    };
    const u1 = this.blobs.observe(cb);
    const u2 = this.config.observe((keys) => {
      cb(expand(keys));
    });
    const subs = [u1, u2];
    if (this.gate?.observe !== undefined) {
      subs.push(
        this.gate.observe((ids) => {
          const keys: string[] = [];
          for (const id of ids)
            for (const [k] of this.config.entries())
              if (k.startsWith(`.obsidian/plugins/${id}/`)) keys.push(k);
          if (keys.length > 0) cb(expand(keys));
        }),
      );
    }
    if (this.versionGate?.observe !== undefined) {
      subs.push(this.versionGate.observe((keys) => cb(expand(keys))));
    }
    return () => {
      for (const u of subs) u();
    };
  }
}
