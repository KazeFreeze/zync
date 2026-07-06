import type { CrdtMap, Unsubscribe, VaultPath } from "../ports.js";
import type { BlobManifestEntry } from "../blobs/blob-engine.js";
import type { ConfigEntry } from "./config-entry.js";
import { isConfigZone, configCategoryOf } from "./config-entry.js";
import { themeReady, themeSiblings } from "./theme-ready.js";

/**
 * Unions the index `blobs` + `config` maps into ONE CrdtMap<BlobManifestEntry> for a single
 * BlobEngine. Reads/writes route by the config-zone prefix; config tombstones are filtered so the
 * fetch queue never materializes a deleted file. Keys are disjoint (config under `.obsidian/`,
 * blobs are vault content), so entries()/observe() merge without collision.
 */
export class RoutedManifest implements CrdtMap<BlobManifestEntry> {
  private readonly cats: { themes: boolean; snippets: boolean };

  constructor(
    private readonly blobs: CrdtMap<BlobManifestEntry>,
    private readonly config: CrdtMap<ConfigEntry>,
    enabledCategories?: { themes: boolean; snippets: boolean },
  ) {
    this.cats = enabledCategories ?? { themes: true, snippets: true };
  }

  /** Returns true when this device materializes files in the given key's config category. */
  private categoryEnabled(key: string): boolean {
    const c = configCategoryOf(key as VaultPath);
    return c !== undefined && this.cats[c];
  }

  get(key: string): BlobManifestEntry | undefined {
    if (isConfigZone(key as never)) {
      if (!this.categoryEnabled(key)) return undefined;
      const e = this.config.get(key);
      if (e === undefined || e.deleted === true) return undefined;
      if (!themeReady(key as VaultPath, (k) => this.config.get(k))) return undefined;
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
      if (e.deleted === true) continue;
      if (!themeReady(k as VaultPath, (kk) => this.config.get(kk))) continue;
      out.push([k, { sha256: e.sha256, size: e.size, deviceId: e.deviceId }]);
    }
    return out;
  }

  observe(cb: (changedKeys: string[]) => void): Unsubscribe {
    const expand = (keys: string[]): string[] => {
      const set = new Set<string>(keys);
      for (const k of keys) {
        if (k.startsWith(".obsidian/themes/"))
          for (const s of themeSiblings(k as VaultPath)) set.add(s);
      }
      return [...set];
    };
    const u1 = this.blobs.observe(cb);
    const u2 = this.config.observe((keys) => {
      cb(expand(keys));
    });
    return () => {
      u1();
      u2();
    };
  }
}
