import { describe, it, expect } from "vitest";
import { RoutedManifest } from "./routed-manifest.js";
import { PluginGate, type PluginMeta } from "./plugin-maps.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import type { CrdtMap, Unsubscribe, VaultPath } from "../ports.js";
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
const P = (sha: string): ConfigEntry => ({
  sha256: sha as never,
  size: 3,
  category: "plugins",
  deviceId: "d" as never,
});
const PD = (sha: string): ConfigEntry => ({
  sha256: sha as never,
  size: 3,
  category: "plugin-data",
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

  describe("PluginGate integration", () => {
    const stubGate = (allow: (id: string) => boolean) => ({
      allows: (path: string) => {
        const m = /^\.obsidian\/plugins\/([^/]+)\//.exec(path);
        const id = m?.[1];
        return id === undefined ? true : allow(id);
      },
    });

    it("gate returning false: ready plugin bundle absent from get and entries", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/plugins/dv/main.js", P("aa"));
      config.set(".obsidian/plugins/dv/manifest.json", P("bb"));
      const rm = new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true, plugins: true },
        stubGate(() => false),
      );
      expect(rm.get(".obsidian/plugins/dv/main.js")).toBeUndefined();
      const keys = rm.entries().map(([k]) => k);
      expect(keys).not.toContain(".obsidian/plugins/dv/main.js");
      expect(keys).not.toContain(".obsidian/plugins/dv/manifest.json");
    });

    it("gate returning true: ready plugin bundle appears in get and entries", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/plugins/dv/main.js", P("aa"));
      config.set(".obsidian/plugins/dv/manifest.json", P("bb"));
      const rm = new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true, plugins: true },
        stubGate(() => true),
      );
      expect(rm.get(".obsidian/plugins/dv/main.js")?.sha256).toBe("aa");
      const keys = rm.entries().map(([k]) => k);
      expect(keys).toContain(".obsidian/plugins/dv/main.js");
    });

    it("gate is transparent for non-plugin paths (themes/snippets always pass)", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/snippets/x.css", C("cc"));
      config.set(".obsidian/themes/Foo/theme.css", T("dd"));
      config.set(".obsidian/themes/Foo/manifest.json", T("ee"));
      const rm = new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true },
        stubGate(() => false), // blocks all plugin ids — should not affect non-plugins
      );
      expect(rm.get(".obsidian/snippets/x.css")?.sha256).toBe("cc");
      expect(rm.get(".obsidian/themes/Foo/theme.css")?.sha256).toBe("dd");
    });
  });

  describe("plugin-ready gate", () => {
    it("half plugin bundle (only main.js) is hidden from get and entries", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/plugins/dv/main.js", P("aa"));
      // manifest.json is absent — plugin bundle is incomplete
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: true,
        snippets: true,
        plugins: true,
      });
      expect(rm.get(".obsidian/plugins/dv/main.js")).toBeUndefined();
      const keys = rm.entries().map(([k]) => k);
      expect(keys).not.toContain(".obsidian/plugins/dv/main.js");
    });

    it("complete plugin bundle (main.js + manifest.json) appears in get and entries", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/plugins/dv/main.js", P("aa"));
      config.set(".obsidian/plugins/dv/manifest.json", P("bb"));
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: true,
        snippets: true,
        plugins: true,
      });
      expect(rm.get(".obsidian/plugins/dv/main.js")?.sha256).toBe("aa");
      const keys = rm
        .entries()
        .map(([k]) => k)
        .sort();
      expect(keys).toContain(".obsidian/plugins/dv/main.js");
      expect(keys).toContain(".obsidian/plugins/dv/manifest.json");
    });

    it("observe expands plugin sibling keys on config fire", () => {
      const config = memMap<ConfigEntry>();
      const rm = new RoutedManifest(memMap<BlobManifestEntry>(), config, {
        themes: true,
        snippets: true,
        plugins: true,
      });
      const seen: string[][] = [];
      rm.observe((keys) => seen.push([...keys]));
      config.fire([".obsidian/plugins/dv/manifest.json"]);
      expect(seen).toHaveLength(1);
      const forwarded = seen[0] ?? [];
      expect(forwarded).toContain(".obsidian/plugins/dv/manifest.json");
      expect(forwarded).toContain(".obsidian/plugins/dv/main.js");
    });
  });

  describe("opt-in after config (order-independent materialization)", () => {
    it("a later optIn.set re-emits the bundle keys AND surfaces it in get/entries", () => {
      // Adversarial delivery order: config entries arrive + are observed-and-gated-out
      // FIRST, then pluginsOptIn[id]=true arrives. Without the gate.observe re-emit, the
      // gated-out bundle would stay hidden until an unrelated config change or restart.
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/plugins/dv/main.js", P("aa"));
      config.set(".obsidian/plugins/dv/manifest.json", P("bb"));
      const optIn = new FakeCrdtMap<boolean>();
      const meta = new FakeCrdtMap<PluginMeta>();
      const gate = new PluginGate(optIn, meta, false);
      const rm = new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true, plugins: true },
        gate,
      );

      // Before opt-in: gated out.
      expect(rm.get(".obsidian/plugins/dv/main.js")).toBeUndefined();
      expect(rm.entries().map(([k]) => k)).not.toContain(".obsidian/plugins/dv/main.js");

      const seen: string[][] = [];
      rm.observe((keys) => seen.push([...keys]));

      // Opt-in arrives AFTER config was already observed.
      optIn.set("dv", true);

      // (a) observe re-fired with the bundle's config keys.
      expect(seen).toHaveLength(1);
      const forwarded = seen[0] ?? [];
      expect(forwarded).toContain(".obsidian/plugins/dv/main.js");
      expect(forwarded).toContain(".obsidian/plugins/dv/manifest.json");

      // (b) the bundle is now surfaced in get/entries (re-triggers materialization).
      expect(rm.get(".obsidian/plugins/dv/main.js")?.sha256).toBe("aa");
      const keys = rm.entries().map(([k]) => k);
      expect(keys).toContain(".obsidian/plugins/dv/main.js");
      expect(keys).toContain(".obsidian/plugins/dv/manifest.json");
    });

    it("a meta.set (isDesktopOnly) also re-emits the affected plugin's keys", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/plugins/dv/main.js", P("aa"));
      config.set(".obsidian/plugins/dv/manifest.json", P("bb"));
      const optIn = new FakeCrdtMap<boolean>();
      const meta = new FakeCrdtMap<PluginMeta>();
      const rm = new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true, plugins: true },
        new PluginGate(optIn, meta, false),
      );
      const seen: string[][] = [];
      rm.observe((keys) => seen.push([...keys]));
      meta.set("dv", { isDesktopOnly: true });
      expect(seen).toHaveLength(1);
      expect(seen[0] ?? []).toContain(".obsidian/plugins/dv/main.js");
    });

    it("an optIn.set for an id with no config entries emits nothing", () => {
      const config = memMap<ConfigEntry>();
      const optIn = new FakeCrdtMap<boolean>();
      const meta = new FakeCrdtMap<PluginMeta>();
      const rm = new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true, plugins: true },
        new PluginGate(optIn, meta, false),
      );
      const seen: string[][] = [];
      rm.observe((keys) => seen.push([...keys]));
      optIn.set("not-installed", true);
      expect(seen).toHaveLength(0);
    });
  });

  describe("plugin-data category flag", () => {
    it("plugin-data entry is invisible when the category flag is off", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/plugins/dv/data.json", PD("aa"));
      const optIn = new FakeCrdtMap<boolean>();
      const meta = new FakeCrdtMap<PluginMeta>();
      optIn.set("dv", true); // plugin IS opted-in — only the category flag suppresses it
      const rm = new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true, plugins: true, "plugin-data": false },
        new PluginGate(optIn, meta, false),
      );
      expect(rm.get(".obsidian/plugins/dv/data.json")).toBeUndefined();
      expect(rm.entries().map(([k]) => k)).not.toContain(".obsidian/plugins/dv/data.json");
    });

    it("plugin-data entry is visible when flag on + opted-in", () => {
      const config = memMap<ConfigEntry>();
      config.set(".obsidian/plugins/dv/data.json", PD("aa"));
      const optIn = new FakeCrdtMap<boolean>();
      const meta = new FakeCrdtMap<PluginMeta>();
      optIn.set("dv", true);
      const rm = new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true, plugins: true, "plugin-data": true },
        new PluginGate(optIn, meta, false),
      );
      expect(rm.get(".obsidian/plugins/dv/data.json")?.sha256).toBe("aa");
      expect(rm.entries().map(([k]) => k)).toContain(".obsidian/plugins/dv/data.json");
    });
  });

  describe("versionGate (plugin-data hold) wiring", () => {
    const DATA = ".obsidian/plugins/dv/data.json";
    const buildRm = (held: Set<string>, observers: ((k: string[]) => void)[]) => {
      const config = memMap<ConfigEntry>();
      config.set(DATA, PD("aa"));
      const optIn = new FakeCrdtMap<boolean>();
      const meta = new FakeCrdtMap<PluginMeta>();
      optIn.set("dv", true); // opted-in + category on: only the versionGate can suppress it
      return new RoutedManifest(
        memMap<BlobManifestEntry>(),
        config,
        { themes: true, snippets: true, plugins: true, "plugin-data": true },
        new PluginGate(optIn, meta, false),
        {
          blocks: (p: VaultPath) => held.has(p),
          observe: (cb: (k: string[]) => void): Unsubscribe => {
            observers.push(cb);
            return () => {};
          },
        },
      );
    };

    it("blocks=true hides the held key from get AND entries", () => {
      const held = new Set<string>([DATA]);
      const rm = buildRm(held, []);
      expect(rm.get(DATA)).toBeUndefined();
      expect(rm.entries().map(([k]) => k)).not.toContain(DATA);
    });

    it("blocks=false surfaces the key in get AND entries", () => {
      const held = new Set<string>(); // not held
      const rm = buildRm(held, []);
      expect(rm.get(DATA)?.sha256).toBe("aa");
      expect(rm.entries().map(([k]) => k)).toContain(DATA);
    });

    it("firing a versionGate observer re-emits the released key through observe", () => {
      const observers: ((k: string[]) => void)[] = [];
      const rm = buildRm(new Set<string>(), observers);
      const seen: string[][] = [];
      rm.observe((keys) => seen.push([...keys]));
      expect(observers).toHaveLength(1);
      observers[0]?.([DATA]);
      expect(seen).toHaveLength(1);
      expect(seen[0] ?? []).toContain(DATA);
    });
  });
});
