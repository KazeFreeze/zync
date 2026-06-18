import { describe, it, expect } from "vitest";
import type { VaultEvent, VaultPath } from "@zync/core";
import { ObsidianVaultPort } from "./obsidian-vault.js";
import { createMockVault } from "./testing/mock-vault.js";

const p = (s: string): VaultPath => s as VaultPath;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

function setup(): { port: ObsidianVaultPort; ext: ReturnType<typeof createMockVault>["external"] } {
  const { vault, external } = createMockVault();
  return { port: new ObsidianVaultPort(vault), ext: external };
}

/** Collect events synchronously (the mock fires external events synchronously). */
function collect(port: ObsidianVaultPort): VaultEvent[] {
  const events: VaultEvent[] = [];
  port.onEvent((e) => events.push(e));
  return events;
}

describe("ObsidianVaultPort — read / writeAtomic / remove / rename", () => {
  it("writeAtomic then read round-trips prose bytes", async () => {
    const { port } = setup();
    await port.writeAtomic(p("notes/hello.md"), enc("world"));
    const result = await port.read(p("notes/hello.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("world");
  });

  it("writeAtomic to an EXISTING prose file updates content (via process)", async () => {
    const { port } = setup();
    await port.writeAtomic(p("a.md"), enc("first"));
    await port.writeAtomic(p("a.md"), enc("second"));
    const result = await port.read(p("a.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("second");
  });

  it("writeAtomic round-trips BINARY bytes exactly (non-UTF-8, via createBinary)", async () => {
    const { port } = setup();
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x03]);
    await port.writeAtomic(p("assets/blob.bin"), bytes);
    const result = await port.read(p("assets/blob.bin"));
    expect(result).not.toBeNull();
    if (result !== null) expect(result).toEqual(bytes);
  });

  it("read returns null for a missing file", async () => {
    const { port } = setup();
    expect(await port.read(p("nope.md"))).toBeNull();
  });

  it("writeAtomic creates parent folders", async () => {
    const { port } = setup();
    await port.writeAtomic(p("deep/nested/path/file.md"), enc("deep"));
    const result = await port.read(p("deep/nested/path/file.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("deep");
  });

  it("writeAtomic forwards mtime (DataWriteOptions passthrough)", async () => {
    const { port } = setup();
    const mtime = 1_700_000_555_000;
    await port.writeAtomic(p("a.md"), enc("hi"), { mtime });
    const entry = (await port.list()).find((e) => e.path === p("a.md"));
    expect(entry).toBeDefined();
    if (entry !== undefined) expect(entry.mtime).toBe(mtime);
  });

  it("remove deletes an existing file", async () => {
    const { port } = setup();
    await port.writeAtomic(p("del.md"), enc("bye"));
    await port.remove(p("del.md"));
    expect(await port.read(p("del.md"))).toBeNull();
  });

  it("remove is a no-op for a missing file (does not throw)", async () => {
    const { port } = setup();
    await expect(port.remove(p("ghost.md"))).resolves.toBeUndefined();
  });

  it("remove emits a delete event synchronously (before await returns)", async () => {
    const { port } = setup();
    await port.writeAtomic(p("gone.md"), enc("bye"));
    const events = collect(port);
    await port.remove(p("gone.md"));
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt !== undefined) {
      expect(evt.type).toBe("delete");
      expect(evt.path).toBe(p("gone.md"));
    }
  });

  it("remove of a missing file emits NO event", async () => {
    const { port } = setup();
    const events = collect(port);
    await port.remove(p("never.md"));
    expect(events).toHaveLength(0);
  });

  it("rename moves the file and updates reads", async () => {
    const { port } = setup();
    await port.writeAtomic(p("old.md"), enc("content"));
    await port.rename(p("old.md"), p("new.md"));
    expect(await port.read(p("old.md"))).toBeNull();
    const result = await port.read(p("new.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("content");
  });

  it("rename emits a rename event synchronously (with oldPath)", async () => {
    const { port } = setup();
    await port.writeAtomic(p("from.md"), enc("data"));
    const events = collect(port);
    await port.rename(p("from.md"), p("to.md"));
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt?.type === "rename") {
      expect(evt.path).toBe(p("to.md"));
      expect(evt.oldPath).toBe(p("from.md"));
    } else {
      expect.fail("expected a rename event");
    }
  });

  it("rename creates the destination's parent folder", async () => {
    const { port } = setup();
    await port.writeAtomic(p("src.md"), enc("hello"));
    await port.rename(p("src.md"), p("subdir/dst.md"));
    const result = await port.read(p("subdir/dst.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("hello");
  });

  it("rename of a missing source is a no-op and emits no event", async () => {
    const { port } = setup();
    const events = collect(port);
    await port.rename(p("nope.md"), p("nope2.md"));
    expect(events).toHaveLength(0);
    expect(await port.read(p("nope2.md"))).toBeNull();
  });
});

describe("ObsidianVaultPort — .obsidian/zync internal zone (DataAdapter routing)", () => {
  it("writeAtomic/read round-trip a base-store file via the adapter", async () => {
    const { port } = setup();
    const path = p(".obsidian/zync/zync/base/doc1.json");
    await port.writeAtomic(path, enc('{"base":true}'));
    const result = await port.read(path);
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe('{"base":true}');
  });

  it("internal-zone files are EXCLUDED from list()", async () => {
    const { port } = setup();
    await port.writeAtomic(p(".obsidian/zync/state.json"), enc("{}"));
    await port.writeAtomic(p("visible.md"), enc("hi"));
    const paths = (await port.list()).map((e) => e.path);
    expect(paths).toContain(p("visible.md"));
    expect(paths.some((x) => x.includes("zync"))).toBe(false);
  });

  it("remove works for an internal-zone file", async () => {
    const { port } = setup();
    const path = p(".obsidian/zync/state.json");
    await port.writeAtomic(path, enc("{}"));
    await port.remove(path);
    expect(await port.read(path)).toBeNull();
  });
});

describe("ObsidianVaultPort — stale-cache races (disk ahead of Obsidian's tree)", () => {
  it("read falls back to the adapter when a file exists on disk but isn't indexed yet", async () => {
    const { port, ext } = setup();
    ext.hiddenPut("unindexed.md", "disk-bytes"); // on disk, not in the Vault tree
    const result = await port.read(p("unindexed.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("disk-bytes");
  });

  it("writeAtomic overwrites (does not throw) when create() rejects on a stale-cache existing file", async () => {
    const { port, ext } = setup();
    ext.hiddenPut("racey.md", "old"); // exists on disk, unindexed → create() branch → create() rejects
    await expect(port.writeAtomic(p("racey.md"), enc("new"))).resolves.toBeUndefined();
    const result = await port.read(p("racey.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("new");
  });

  it("writeAtomic updates an EXISTING binary file via modifyBinary", async () => {
    const { port } = setup();
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([9, 8, 7, 6, 5]);
    await port.writeAtomic(p("blob.bin"), a);
    await port.writeAtomic(p("blob.bin"), b); // existing TFile → modifyBinary path
    const result = await port.read(p("blob.bin"));
    expect(result).not.toBeNull();
    if (result !== null) expect(result).toEqual(b);
  });
});

describe("ObsidianVaultPort — list()", () => {
  it("lists all visible files", async () => {
    const { port } = setup();
    await port.writeAtomic(p("a.md"), enc("a"));
    await port.writeAtomic(p("sub/b.md"), enc("b"));
    const paths = (await port.list()).map((e) => e.path).sort();
    expect(paths).toEqual([p("a.md"), p("sub/b.md")]);
  });

  it("list with a prefix filters", async () => {
    const { port } = setup();
    await port.writeAtomic(p("notes/a.md"), enc("a"));
    await port.writeAtomic(p("notes/b.md"), enc("b"));
    await port.writeAtomic(p("attachments/img.png"), enc("img"));
    const paths = (await port.list(p("notes/"))).map((e) => e.path).sort();
    expect(paths).toEqual([p("notes/a.md"), p("notes/b.md")]);
  });

  it("list returns size + mtime metadata", async () => {
    const { port } = setup();
    const data = enc("hello world");
    await port.writeAtomic(p("meta.md"), data);
    const [entry] = await port.list();
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(entry.size).toBe(data.byteLength);
      expect(entry.mtime).toBeGreaterThan(0);
    }
  });
});

describe("ObsidianVaultPort — event forwarding", () => {
  it("forwards external create / modify / delete", () => {
    const { port, ext } = setup();
    const events = collect(port);
    ext.create("ext.md", "x");
    ext.modify("ext.md", "y");
    ext.delete("ext.md");
    expect(events.map((e) => `${e.type}:${e.path}`)).toEqual([
      "create:ext.md",
      "modify:ext.md",
      "delete:ext.md",
    ]);
  });

  it("forwards external rename with oldPath", () => {
    const { port, ext } = setup();
    ext.create("from.md", "x");
    const events = collect(port);
    ext.rename("from.md", "to.md");
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt?.type === "rename") {
      expect(evt.path).toBe(p("to.md"));
      expect(evt.oldPath).toBe(p("from.md"));
    } else {
      expect.fail("expected a rename event");
    }
  });

  it("DROPS folder events (TFolder filtered out)", () => {
    const { port, ext } = setup();
    const events = collect(port);
    ext.folderCreate("somefolder");
    expect(events).toHaveLength(0);
  });

  it("DROPS events for the .obsidian/zync internal zone", () => {
    const { port, ext } = setup();
    const events = collect(port);
    ext.create(".obsidian/zync/state.json", "{}");
    ext.modify(".obsidian/zync/state.json", "{}");
    expect(events).toHaveLength(0);
  });

  it("onEvent unsubscribe stops delivery", () => {
    const { port, ext } = setup();
    const events: VaultEvent[] = [];
    const unsub = port.onEvent((e) => events.push(e));
    unsub();
    ext.create("a.md", "x");
    expect(events).toHaveLength(0);
  });

  it("close() detaches handlers — no events after close", () => {
    const { port, ext } = setup();
    const events = collect(port);
    port.close();
    ext.create("a.md", "x");
    expect(events).toHaveLength(0);
  });
});
