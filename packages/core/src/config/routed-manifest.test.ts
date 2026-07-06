import { describe, it, expect } from "vitest";
import { RoutedManifest } from "./routed-manifest.js";
import type { CrdtMap, Unsubscribe } from "../ports.js";
import type { BlobManifestEntry } from "../blobs/blob-engine.js";
import type { ConfigEntry } from "./config-entry.js";

// Minimal in-memory CrdtMap for tests.
function memMap<V>(): CrdtMap<V> & { fire: (keys: string[]) => void } {
  const m = new Map<string, V>();
  const subs = new Set<(k: string[]) => void>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
    },
    delete: (k) => {
      m.delete(k);
    },
    entries: () => [...m.entries()],
    observe(cb): Unsubscribe {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    fire: (keys) => {
      subs.forEach((cb) => {
        cb(keys);
      });
    },
  };
}

const B = (sha: string): BlobManifestEntry => ({
  sha256: sha as never,
  size: 3,
  deviceId: "d" as never,
});
const C = (sha: string, deleted?: boolean): ConfigEntry => ({
  sha256: sha as never,
  size: 3,
  category: "snippets",
  deviceId: "d" as never,
  ...(deleted ? { deleted } : {}),
});
const T = (sha: string): ConfigEntry => ({
  sha256: sha as never,
  size: 3,
  category: "themes",
  deviceId: "d" as never,
});

describe("RoutedManifest", () => {
  it("get routes by config-zone prefix", () => {
    const blobs = memMap<BlobManifestEntry>();
    const config = memMap<ConfigEntry>();
    blobs.set("img/a.png", B("aa"));
    config.set(".obsidian/snippets/x.css", C("bb"));
    const rm = new RoutedManifest(blobs, config, { themes: true, snippets: true });
    expect(rm.get("img/a.png")?.sha256).toBe("aa");
    expect(rm.get(".obsidian/snippets/x.css")?.sha256).toBe("bb");
  });
  it("entries unions both maps and filters config tombstones", () => {
    const blobs = memMap<BlobManifestEntry>();
    const config = memMap<ConfigEntry>();
    blobs.set("img/a.png", B("aa"));
    config.set(".obsidian/snippets/live.css", C("bb"));
    config.set(".obsidian/snippets/dead.css", C("cc", true));
    const rm = new RoutedManifest(blobs, config, { themes: true, snippets: true });
    const keys = rm
      .entries()
      .map(([k]) => k)
      .sort();
    expect(keys).toEqual(["img/a.png", ".obsidian/snippets/live.css"].sort());
  });
  it("get treats a config tombstone as absent", () => {
    const config = memMap<ConfigEntry>();
    config.set(".obsidian/snippets/dead.css", C("cc", true));
    const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
      themes: true,
      snippets: true,
    });
    expect(rm.get(".obsidian/snippets/dead.css")).toBeUndefined();
  });
  it("observe fans changes from both maps", () => {
    const blobs = memMap<BlobManifestEntry>();
    const config = memMap<ConfigEntry>();
    const rm = new RoutedManifest(blobs, config, { themes: true, snippets: true });
    const seen: string[] = [];
    rm.observe((keys) => seen.push(...keys));
    blobs.fire(["img/a.png"]);
    config.fire([".obsidian/snippets/x.css"]);
    expect(seen).toEqual(["img/a.png", ".obsidian/snippets/x.css"]);
  });

  describe("theme-ready gate", () => {
    it("half-theme is hidden from get and entries", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/themes/Foo/theme.css", T("aa"));
      // manifest.json is absent — theme is incomplete
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: true,
        snippets: true,
      });
      expect(rm.get(".obsidian/themes/Foo/theme.css")).toBeUndefined();
      const keys = rm.entries().map(([k]) => k);
      expect(keys).not.toContain(".obsidian/themes/Foo/theme.css");
    });

    it("complete theme is surfaced in get and entries", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/themes/Foo/theme.css", T("aa"));
      config.set(".obsidian/themes/Foo/manifest.json", T("bb"));
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: true,
        snippets: true,
      });
      expect(rm.get(".obsidian/themes/Foo/theme.css")?.sha256).toBe("aa");
      const keys = rm
        .entries()
        .map(([k]) => k)
        .sort();
      expect(keys).toEqual([
        ".obsidian/themes/Foo/manifest.json",
        ".obsidian/themes/Foo/theme.css",
      ]);
    });

    it("snippet is always surfaced (single-file, no sibling requirement)", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/snippets/x.css", C("cc"));
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: true,
        snippets: true,
      });
      expect(rm.get(".obsidian/snippets/x.css")?.sha256).toBe("cc");
      const keys = rm.entries().map(([k]) => k);
      expect(keys).toContain(".obsidian/snippets/x.css");
    });

    it("observe expands theme sibling keys on config fire", () => {
      const config = memMap<ConfigEntry>();
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: true,
        snippets: true,
      });
      const seen: string[][] = [];
      rm.observe((keys) => seen.push([...keys]));
      config.fire([".obsidian/themes/Foo/manifest.json"]);
      expect(seen).toHaveLength(1);
      const forwarded = seen[0] ?? [];
      expect(forwarded).toContain(".obsidian/themes/Foo/manifest.json");
      expect(forwarded).toContain(".obsidian/themes/Foo/theme.css");
    });
  });

  describe("enabledCategories policy", () => {
    it("get: themes-disabled device returns undefined for a live theme entry", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/themes/Foo/theme.css", T("aa"));
      config.set(".obsidian/themes/Foo/manifest.json", T("bb"));
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: false,
        snippets: true,
      });
      expect(rm.get(".obsidian/themes/Foo/theme.css")).toBeUndefined();
      expect(rm.get(".obsidian/themes/Foo/manifest.json")).toBeUndefined();
    });

    it("get: themes-disabled device still returns snippets entries", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/snippets/x.css", C("cc"));
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: false,
        snippets: true,
      });
      expect(rm.get(".obsidian/snippets/x.css")?.sha256).toBe("cc");
    });

    it("entries: themes-disabled device excludes theme entries from the manifest", () => {
      const blobs = memMap<BlobManifestEntry>();
      const config = memMap<ConfigEntry>();
      blobs.set("img/a.png", B("aa"));
      config.set(".obsidian/themes/Foo/theme.css", T("bb"));
      config.set(".obsidian/themes/Foo/manifest.json", T("cc"));
      config.set(".obsidian/snippets/x.css", C("dd"));
      const rm = new RoutedManifest(blobs, config, { themes: false, snippets: true });
      const keys = rm
        .entries()
        .map(([k]) => k)
        .sort();
      expect(keys).toEqual(["img/a.png", ".obsidian/snippets/x.css"].sort());
      expect(keys).not.toContain(".obsidian/themes/Foo/theme.css");
      expect(keys).not.toContain(".obsidian/themes/Foo/manifest.json");
    });

    it("entries: both-disabled device only returns blob entries", () => {
      const blobs = memMap<BlobManifestEntry>();
      const config = memMap<ConfigEntry>();
      blobs.set("img/a.png", B("aa"));
      config.set(".obsidian/snippets/x.css", C("bb"));
      config.set(".obsidian/themes/Foo/theme.css", T("cc"));
      config.set(".obsidian/themes/Foo/manifest.json", T("dd"));
      const rm = new RoutedManifest(blobs, config, { themes: false, snippets: false });
      const keys = rm.entries().map(([k]) => k);
      expect(keys).toEqual(["img/a.png"]);
    });

    it("absent enabledCategories defaults to both-enabled (back-compat)", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/themes/Foo/theme.css", T("aa"));
      config.set(".obsidian/themes/Foo/manifest.json", T("bb"));
      config.set(".obsidian/snippets/x.css", C("cc"));
      // No 3rd arg — old call-site pattern
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config);
      expect(rm.get(".obsidian/themes/Foo/theme.css")?.sha256).toBe("aa");
      expect(rm.get(".obsidian/snippets/x.css")?.sha256).toBe("cc");
    });
  });
});
