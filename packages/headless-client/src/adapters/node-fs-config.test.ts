import { describe, it, expect, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { VaultPath } from "@zync/core";
import { NodeFsConfig } from "./node-fs-config.js";

const p = (s: string): VaultPath => s as VaultPath;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

const configs: NodeFsConfig[] = [];

function track(c: NodeFsConfig): NodeFsConfig {
  configs.push(c);
  return c;
}

afterEach(() => {
  for (const c of configs.splice(0)) c.close();
});

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "zync-config-test-"));
}

describe("NodeFsConfig — read / writeAtomic / list / remove round-trip", () => {
  it("writeAtomic then read round-trips bytes for a snippet", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    const data = enc("body { color: red; }");
    await config.writeAtomic(p(".obsidian/snippets/my.css"), data);

    const result = await config.read(p(".obsidian/snippets/my.css"));
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(dec(result)).toBe("body { color: red; }");
    }
  });

  it("writeAtomic then read round-trips bytes for a theme file", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    const data = enc(".theme { background: #000; }");
    await config.writeAtomic(p(".obsidian/themes/dark/theme.css"), data);

    const result = await config.read(p(".obsidian/themes/dark/theme.css"));
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(dec(result)).toBe(".theme { background: #000; }");
    }
  });

  it("list returns written files with correct size", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    const data = enc("snippet content");
    await config.writeAtomic(p(".obsidian/snippets/test.css"), data);
    await config.writeAtomic(p(".obsidian/themes/my-theme/theme.css"), enc("theme content"));

    const files = await config.list();
    const paths = files.map((f) => f.path);
    expect(paths).toContain(".obsidian/snippets/test.css");
    expect(paths).toContain(".obsidian/themes/my-theme/theme.css");

    const snippet = files.find((f) => f.path === ".obsidian/snippets/test.css");
    expect(snippet?.size).toBe(data.length);
  });

  it("remove deletes the file; read returns null after remove", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    await config.writeAtomic(p(".obsidian/snippets/gone.css"), enc("delete me"));
    expect(await config.read(p(".obsidian/snippets/gone.css"))).not.toBeNull();

    await config.remove(p(".obsidian/snippets/gone.css"));

    expect(await config.read(p(".obsidian/snippets/gone.css"))).toBeNull();
    const files = await config.list();
    expect(files.map((f) => f.path)).not.toContain(".obsidian/snippets/gone.css");
  });

  it("remove is idempotent (ENOENT is silenced)", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    // Should not throw even if the file never existed.
    await expect(config.remove(p(".obsidian/snippets/nonexistent.css"))).resolves.toBeUndefined();
  });
});

describe("NodeFsConfig — zone enforcement", () => {
  it("read outside the config zone returns null", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    // Write a file directly via fsp (bypassing zone checks).
    await fsp.mkdir(path.join(dir, ".obsidian", "plugins"), { recursive: true });
    await fsp.writeFile(path.join(dir, ".obsidian", "plugins", "data.json"), "{}");

    expect(await config.read(p(".obsidian/plugins/data.json"))).toBeNull();
    expect(await config.read(p("notes/regular.md"))).toBeNull();
  });

  it("list omits files outside the config zone (themes/snippets only)", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    await config.writeAtomic(p(".obsidian/snippets/a.css"), enc("a"));
    // Write a file outside the zone directly.
    await fsp.mkdir(path.join(dir, ".obsidian", "plugins"), { recursive: true });
    await fsp.writeFile(path.join(dir, ".obsidian", "plugins", "plugin.json"), "{}");

    const files = await config.list();
    const paths = files.map((f) => f.path);
    expect(paths).toContain(".obsidian/snippets/a.css");
    expect(paths).not.toContain(".obsidian/plugins/plugin.json");
  });

  it("list returns empty when neither zone dir exists", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    const files = await config.list();
    expect(files).toEqual([]);
  });

  it("remove silently no-ops for an out-of-zone path (zone guard)", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    // Write a file outside the zone directly.
    const notesDir = path.join(dir, "notes");
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.writeFile(path.join(notesDir, "keep.md"), "keep me");

    // remove() must not delete it (zone guard blocks the unlink).
    await config.remove(p("notes/keep.md"));

    const still = await fsp.readFile(path.join(notesDir, "keep.md"), "utf8");
    expect(still).toBe("keep me");
  });

  it("writeAtomic silently no-ops for an out-of-zone path", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    // writeAtomic must not write outside the zone.
    await config.writeAtomic(p("notes/evil.md"), enc("bad"));

    const notesFile = path.join(dir, "notes", "evil.md");
    await expect(fsp.access(notesFile)).rejects.toThrow();
  });

  it("writeAtomic throws for a path with a '..' traversal segment (abs() guard)", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    const traversal = p(".obsidian/snippets/../../evil.css");
    await expect(config.writeAtomic(traversal, enc("bad"))).rejects.toThrow(/escapes/i);
  });

  it("remove throws for a path with a '..' traversal segment (abs() guard)", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    const traversal = p(".obsidian/snippets/../../evil.css");
    await expect(config.remove(traversal)).rejects.toThrow(/escapes/i);
  });
});

describe("NodeFsConfig — rescan fires onChange for out-of-band changes", () => {
  it("rescan fires onChange for a file created out-of-band", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    const fired: VaultPath[] = [];
    config.onChange((p) => fired.push(p));

    // Create a snippet out-of-band (bypassing the ConfigPort).
    await fsp.mkdir(path.join(dir, ".obsidian", "snippets"), { recursive: true });
    await fsp.writeFile(path.join(dir, ".obsidian", "snippets", "oob.css"), ".oob {}");

    await config.rescan();

    expect(fired).toContain(".obsidian/snippets/oob.css" as VaultPath);
  });

  it("rescan fires onChange for a file removed out-of-band", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    // Write via the port so it appears in lastKnown.
    await config.writeAtomic(p(".obsidian/snippets/remove-me.css"), enc("x"));
    // Seed the lastKnown state via an initial rescan.
    await config.rescan();

    const fired: VaultPath[] = [];
    config.onChange((vp) => fired.push(vp));

    // Remove out-of-band.
    await fsp.unlink(path.join(dir, ".obsidian", "snippets", "remove-me.css"));

    await config.rescan();

    expect(fired).toContain(".obsidian/snippets/remove-me.css" as VaultPath);
  });

  it("onChange unsub stops receiving callbacks", async () => {
    const dir = await makeTmpDir();
    const config = track(new NodeFsConfig(dir));

    const fired: VaultPath[] = [];
    const unsub = config.onChange((p) => fired.push(p));

    // Create a file so first rescan fires.
    await fsp.mkdir(path.join(dir, ".obsidian", "snippets"), { recursive: true });
    await fsp.writeFile(path.join(dir, ".obsidian", "snippets", "sub.css"), "a");
    await config.rescan();
    expect(fired.length).toBe(1);

    // Unsubscribe; subsequent rescan must not fire.
    unsub();
    await fsp.writeFile(path.join(dir, ".obsidian", "snippets", "sub.css"), "b");
    await config.rescan();
    expect(fired.length).toBe(1); // still 1 — unsub took effect
  });
});
