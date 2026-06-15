import { describe, it, expect, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { VaultPath, VaultEvent } from "@zync/core";
import { NodeFsVault } from "./node-fs-vault.js";

const p = (s: string): VaultPath => s as VaultPath;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "zync-vault-test-"));
}

/** Await a vault event with a bounded timeout (ms). Throws if no event arrives in time. */
async function awaitEvent(vault: NodeFsVault, timeoutMs = 2000): Promise<VaultEvent> {
  return new Promise<VaultEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("Timed out waiting for vault event"));
    }, timeoutMs);
    const unsub = vault.onEvent((e) => {
      clearTimeout(timer);
      unsub();
      resolve(e);
    });
  });
}

const vaults: NodeFsVault[] = [];
function track(v: NodeFsVault): NodeFsVault {
  vaults.push(v);
  return v;
}

afterEach(() => {
  for (const v of vaults.splice(0)) v.close();
});

describe("NodeFsVault — read / writeAtomic / remove / rename (deterministic)", () => {
  it("writeAtomic then read round-trips bytes", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("notes/hello.md"), enc("world"));
    const result = await vault.read(p("notes/hello.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("world");
  });

  it("read returns null for missing file", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    expect(await vault.read(p("nope.md"))).toBeNull();
  });

  it("writeAtomic creates parent directories", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("deep/nested/path/file.md"), enc("deep"));
    const result = await vault.read(p("deep/nested/path/file.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("deep");
  });

  it("writeAtomic honours mtime option", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    const mtime = 1_700_000_000_000; // a specific epoch ms
    await vault.writeAtomic(p("a.md"), enc("hi"), { mtime });
    const entries = await vault.list();
    const entry = entries.find((e) => e.path === p("a.md"));
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      // mtime is set via utimes which has ~1 s resolution; allow ±1000 ms slop
      expect(Math.abs(entry.mtime - mtime)).toBeLessThan(1001);
    }
  });

  it("writeAtomic leaves no temp file behind", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("file.md"), enc("content"));
    const raw = await fsp.readdir(dir);
    expect(raw.some((n) => n.startsWith(".zync-tmp-"))).toBe(false);
  });

  it("remove deletes existing file", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("del.md"), enc("bye"));
    await vault.remove(p("del.md"));
    expect(await vault.read(p("del.md"))).toBeNull();
  });

  it("remove is no-op for missing file (does not throw)", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await expect(vault.remove(p("ghost.md"))).resolves.toBeUndefined();
  });

  it("remove emits a delete event synchronously (before await returns)", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("gone.md"), enc("bye"));

    const events: VaultEvent[] = [];
    vault.onEvent((e) => events.push(e));

    await vault.remove(p("gone.md"));

    // The synthetic delete must be present immediately after remove resolves so a caller
    // can await it and KNOW the engine observed the deletion (not depend on the watcher).
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt).toBeDefined();
    if (evt !== undefined) {
      expect(evt.type).toBe("delete");
      expect(evt.path).toBe(p("gone.md"));
    }
  });

  it("remove of a missing file emits NO event", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    const events: VaultEvent[] = [];
    vault.onEvent((e) => events.push(e));
    await vault.remove(p("never-existed.md"));
    expect(events).toHaveLength(0);
  });

  it("rename moves the file on disk and updates reads", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("old.md"), enc("content"));
    await vault.rename(p("old.md"), p("new.md"));
    expect(await vault.read(p("old.md"))).toBeNull();
    const result = await vault.read(p("new.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("content");
  });

  it("rename emits a rename event synchronously (before await returns)", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("from.md"), enc("data"));

    const events: VaultEvent[] = [];
    vault.onEvent((e) => events.push(e));

    await vault.rename(p("from.md"), p("to.md"));

    // The event must be present immediately after the rename resolves.
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt).toBeDefined();
    if (evt !== undefined) {
      expect(evt.type).toBe("rename");
      if (evt.type === "rename") {
        expect(evt.path).toBe(p("to.md"));
        expect(evt.oldPath).toBe(p("from.md"));
      }
    }
  });

  it("rename creates parent directory for destination", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("src.md"), enc("hello"));
    await vault.rename(p("src.md"), p("subdir/dst.md"));
    const result = await vault.read(p("subdir/dst.md"));
    expect(result).not.toBeNull();
    if (result !== null) expect(dec(result)).toBe("hello");
  });

  it("onEvent unsubscribe stops receiving events", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    const received: VaultEvent[] = [];
    const unsub = vault.onEvent((e) => received.push(e));
    unsub();
    await vault.rename(p("nope.md"), p("nope2.md")).catch(() => undefined);
    expect(received).toHaveLength(0);
  });
});

describe("NodeFsVault — list()", () => {
  it("lists all files recursively", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("a.md"), enc("a"));
    await vault.writeAtomic(p("sub/b.md"), enc("b"));
    const paths = (await vault.list()).map((e) => e.path).sort();
    expect(paths).toEqual([p("a.md"), p("sub/b.md")]);
  });

  it("list with prefix filters correctly", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    await vault.writeAtomic(p("notes/a.md"), enc("a"));
    await vault.writeAtomic(p("notes/b.md"), enc("b"));
    await vault.writeAtomic(p("attachments/img.png"), enc("img"));
    const paths = (await vault.list(p("notes/"))).map((e) => e.path).sort();
    expect(paths).toEqual([p("notes/a.md"), p("notes/b.md")]);
  });

  it("excludes .obsidian/zync/ from list", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    // Write directly to bypass exclusion in writeAtomic (which doesn't exclude)
    const hidden = path.join(dir, ".obsidian", "zync", "state.json");
    await fsp.mkdir(path.dirname(hidden), { recursive: true });
    await fsp.writeFile(hidden, "secret");
    await vault.writeAtomic(p("visible.md"), enc("hi"));
    const paths = (await vault.list()).map((e) => e.path);
    expect(paths).not.toContain(".obsidian/zync/state.json");
    expect(paths).toContain(p("visible.md"));
  });

  it("list returns size and mtime metadata", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));
    const data = enc("hello world");
    await vault.writeAtomic(p("meta.md"), data);
    const [entry] = await vault.list();
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(entry.size).toBe(data.byteLength);
      expect(entry.mtime).toBeGreaterThan(0);
    }
  });
});

describe("NodeFsVault — external watcher events", () => {
  it("detects an externally created file and emits an event", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));

    const eventP = awaitEvent(vault);
    await fsp.writeFile(path.join(dir, "external.md"), "written outside");
    const evt = await eventP;
    expect(["create", "modify"]).toContain(evt.type);
    expect(evt.path).toContain("external.md");
  });

  it("does not emit events for .obsidian/zync/ paths", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));

    const received: VaultEvent[] = [];
    vault.onEvent((e) => received.push(e));

    const hidden = path.join(dir, ".obsidian", "zync", "internal.json");
    await fsp.mkdir(path.dirname(hidden), { recursive: true });
    await fsp.writeFile(hidden, "{}");

    // Wait briefly — if the watcher fires incorrectly we'd catch it.
    await new Promise<void>((r) => setTimeout(r, 200));
    const internal = received.filter((e) => e.path.includes("zync"));
    expect(internal).toHaveLength(0);
  });

  it("does not emit events for .zync-tmp-* temp files", async () => {
    const dir = await makeTmpDir();
    const vault = track(new NodeFsVault(dir));

    const received: VaultEvent[] = [];
    vault.onEvent((e) => received.push(e));

    // Write a file whose name starts with the temp prefix directly into the
    // watched directory — the watcher should suppress it.
    await fsp.writeFile(path.join(dir, ".zync-tmp-suppressed"), "tmp");

    // Wait long enough for any coalesce timer (20 ms) + fs.stat callback to fire.
    await new Promise<void>((r) => setTimeout(r, 200));
    const tmpEvents = received.filter((e) => e.path.includes(".zync-tmp-"));
    expect(tmpEvents).toHaveLength(0);
  });

  it("does not emit events after close()", async () => {
    const dir = await makeTmpDir();
    // Do NOT use track() — we close manually inside the test.
    const vault = new NodeFsVault(dir);

    const received: VaultEvent[] = [];
    vault.onEvent((e) => received.push(e));

    // Close before any external write so any in-flight stat callbacks are racing.
    vault.close();

    // Write an external file — if the watcher somehow fires after close the
    // event must be suppressed by the closed guard.
    await fsp.writeFile(path.join(dir, "post-close.md"), "late");
    await new Promise<void>((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
  });
});
