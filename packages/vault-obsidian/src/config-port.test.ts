/**
 * ObsidianConfigPort — unit tests against the mock vault.
 *
 * What this proves:
 *   - write/read/remove adapter round-trip via the DataAdapter path.
 *   - list() returns config-zone files and excludes non-zone files.
 *   - onChange fires when external.raw() emits a config-zone path.
 *   - onChange does NOT fire for self-excluded paths (.obsidian/zync/, .obsidian/plugins/zync/).
 *   - onChange does NOT fire for non-zone raw paths.
 *
 * What this does NOT prove (manual on-device gate):
 *   - Real Obsidian "raw" event wiring via vault.on("raw", ...).
 *   - Real DataAdapter behaviour on the actual filesystem.
 *   - Live-apply correctness (the engine's ConfigChannel handles that).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VaultPath } from "@zync/core";
import { createMockVault } from "./testing/mock-vault.js";
import { ObsidianConfigPort } from "./config-port.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);
const vp = (s: string): VaultPath => s as VaultPath;

describe("ObsidianConfigPort", () => {
  let port: ObsidianConfigPort;
  let external: ReturnType<typeof createMockVault>["external"];

  beforeEach(() => {
    const mock = createMockVault();
    port = new ObsidianConfigPort(mock.vault);
    external = mock.external;
  });

  afterEach(() => {
    port.close();
  });

  // ---------------------------------------------------------------------------
  // read / writeAtomic / remove round-trip
  // ---------------------------------------------------------------------------

  describe("read / writeAtomic / remove", () => {
    it("writes and reads back bytes for a themes path", async () => {
      const path = vp(".obsidian/themes/dark.css");
      const data = enc("body { color: #222; }");
      await port.writeAtomic(path, data);
      const result = await port.read(path);
      expect(result).not.toBeNull();
      expect(dec(result ?? new Uint8Array())).toBe("body { color: #222; }");
    });

    it("writes and reads back bytes for a snippets path", async () => {
      const path = vp(".obsidian/snippets/custom.css");
      const data = enc("p { margin: 0; }");
      await port.writeAtomic(path, data);
      const result = await port.read(path);
      expect(result).not.toBeNull();
      expect(dec(result ?? new Uint8Array())).toBe("p { margin: 0; }");
    });

    it("returns null for an absent config-zone path", async () => {
      const result = await port.read(vp(".obsidian/themes/nonexistent.css"));
      expect(result).toBeNull();
    });

    it("returns null for a non-config-zone path (zone guard)", async () => {
      // Even if the file exists on the adapter, read() must refuse non-zone paths.
      external.hiddenPut("notes/foo.md", "hello");
      const result = await port.read(vp("notes/foo.md"));
      expect(result).toBeNull();
    });

    it("remove deletes a previously written file", async () => {
      const path = vp(".obsidian/snippets/rem.css");
      await port.writeAtomic(path, enc("a { color: red; }"));
      await port.remove(path);
      const result = await port.read(path);
      expect(result).toBeNull();
    });

    it("remove on an absent path is a no-op (does not throw)", async () => {
      await expect(port.remove(vp(".obsidian/themes/absent.css"))).resolves.toBeUndefined();
    });

    it("overwrites an existing file on re-write", async () => {
      const path = vp(".obsidian/themes/overwrite.css");
      await port.writeAtomic(path, enc("v1"));
      await port.writeAtomic(path, enc("v2"));
      const result = await port.read(path);
      expect(dec(result ?? new Uint8Array())).toBe("v2");
    });
  });

  // ---------------------------------------------------------------------------
  // list()
  // ---------------------------------------------------------------------------

  describe("list()", () => {
    it("returns themes and snippets files written via writeAtomic", async () => {
      await port.writeAtomic(vp(".obsidian/themes/dark.css"), enc("a"));
      await port.writeAtomic(vp(".obsidian/snippets/custom.css"), enc("b"));
      const entries = await port.list();
      const paths = entries.map((e) => e.path);
      expect(paths).toContain(".obsidian/themes/dark.css");
      expect(paths).toContain(".obsidian/snippets/custom.css");
    });

    it("does not include files outside the config zone", async () => {
      external.hiddenPut("notes/foo.md", "hello");
      external.hiddenPut(".obsidian/workspace.json", "{}");
      const entries = await port.list();
      const paths = entries.map((e) => e.path);
      expect(paths).not.toContain("notes/foo.md");
      expect(paths).not.toContain(".obsidian/workspace.json");
    });

    it("returns empty list when config zone is empty", async () => {
      const entries = await port.list();
      expect(entries).toHaveLength(0);
    });

    it("reports correct size", async () => {
      const content = enc("body {}");
      await port.writeAtomic(vp(".obsidian/themes/size.css"), content);
      const entries = await port.list();
      const entry = entries.find((e) => e.path === ".obsidian/themes/size.css");
      expect(entry).toBeDefined();
      expect(entry?.size).toBe(content.byteLength);
    });
  });

  // ---------------------------------------------------------------------------
  // onChange — raw watcher
  // ---------------------------------------------------------------------------

  describe("onChange via raw watcher", () => {
    it("fires when external.raw emits a snippets zone path", () => {
      const cb = vi.fn();
      port.onChange(cb);
      external.raw(".obsidian/snippets/x.css");
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(".obsidian/snippets/x.css");
    });

    it("fires when external.raw emits a themes zone path", () => {
      const cb = vi.fn();
      port.onChange(cb);
      external.raw(".obsidian/themes/dark.css");
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(".obsidian/themes/dark.css");
    });

    it("does NOT fire for .obsidian/zync/ paths (self-exclusion)", () => {
      const cb = vi.fn();
      port.onChange(cb);
      external.raw(".obsidian/zync/foo");
      external.raw(".obsidian/zync/base/note1.json");
      expect(cb).not.toHaveBeenCalled();
    });

    it("does NOT fire for .obsidian/plugins/zync/ paths (self-exclusion)", () => {
      const cb = vi.fn();
      port.onChange(cb);
      external.raw(".obsidian/plugins/zync/main.js");
      external.raw(".obsidian/plugins/zync/manifest.json");
      expect(cb).not.toHaveBeenCalled();
    });

    it("does NOT fire for non-zone raw paths", () => {
      const cb = vi.fn();
      port.onChange(cb);
      external.raw("notes/foo.md");
      external.raw(".obsidian/workspace.json");
      external.raw(".obsidian/app.json");
      expect(cb).not.toHaveBeenCalled();
    });

    it("can register multiple listeners", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      port.onChange(cb1);
      port.onChange(cb2);
      external.raw(".obsidian/themes/dark.css");
      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
    });

    it("unsubscribe stops future callbacks", () => {
      const cb = vi.fn();
      const unsub = port.onChange(cb);
      unsub();
      external.raw(".obsidian/themes/dark.css");
      expect(cb).not.toHaveBeenCalled();
    });

    it("unsubscribing one listener does not affect others", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const unsub1 = port.onChange(cb1);
      port.onChange(cb2);
      unsub1();
      external.raw(".obsidian/themes/dark.css");
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // Zone guard + path-traversal rejection
  // ---------------------------------------------------------------------------

  describe("zone guard + path traversal rejection", () => {
    it("writeAtomic silently no-ops for an out-of-zone path", async () => {
      const outOfZone = vp("notes/evil.md");
      await port.writeAtomic(outOfZone, enc("bad data"));
      // The file must not have been written to the adapter.
      expect(external.peek("notes/evil.md")).toBeNull();
    });

    it("remove silently no-ops for an out-of-zone path", async () => {
      // Pre-seed a file outside the zone directly on the adapter.
      external.hiddenPut("notes/existing.md", "keep me");
      await port.remove(vp("notes/existing.md"));
      // The file must NOT have been deleted.
      expect(external.peek("notes/existing.md")).not.toBeNull();
    });

    it("writeAtomic throws for a path with a '..' traversal segment", async () => {
      const traversal = vp(".obsidian/snippets/../../evil.css");
      await expect(port.writeAtomic(traversal, enc("bad data"))).rejects.toThrow(/traversal/i);
      // Nothing written — the file must not exist.
      expect(external.peek(".obsidian/snippets/../../evil.css")).toBeNull();
    });

    it("remove throws for a path with a '..' traversal segment", async () => {
      const traversal = vp(".obsidian/snippets/../../evil.css");
      await expect(port.remove(traversal)).rejects.toThrow(/traversal/i);
    });

    it("read returns null for a path with a '..' traversal segment", async () => {
      const traversal = vp(".obsidian/snippets/../../evil.css");
      expect(await port.read(traversal)).toBeNull();
    });

    it("read returns null for an out-of-zone path even if data is on the adapter", async () => {
      external.hiddenPut("notes/secret.md", "secret");
      expect(await port.read(vp("notes/secret.md"))).toBeNull();
    });
  });
});
