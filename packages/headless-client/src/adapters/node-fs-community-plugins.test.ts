import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFsCommunityPlugins } from "./node-fs-community-plugins.js";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function root() {
  dir = mkdtempSync(join(tmpdir(), "zync-cp-"));
  mkdirSync(join(dir, ".obsidian"), { recursive: true });
  return dir;
}

describe("NodeFsCommunityPlugins", () => {
  it("read returns null when the file is absent, then the parsed array", async () => {
    const p = new NodeFsCommunityPlugins(root());
    expect(await p.read()).toBeNull();
    await p.writeAtomic(["dv", "tp"]);
    expect((await p.read())?.sort()).toEqual(["dv", "tp"]);
    p.close();
  });
  it("writeAtomic produces a valid JSON array Obsidian can read", async () => {
    const r = root();
    const p = new NodeFsCommunityPlugins(r);
    await p.writeAtomic(["dv"]);
    const raw = (await import("node:fs/promises")).readFile(
      join(r, ".obsidian/community-plugins.json"),
      "utf8",
    );
    expect(JSON.parse(await raw)).toEqual(["dv"]);
    p.close();
  });
  it("onChange fires when the file changes externally", async () => {
    const r = root();
    const p = new NodeFsCommunityPlugins(r);
    let fired = 0;
    p.onChange(() => {
      fired++;
    });
    writeFileSync(join(r, ".obsidian/community-plugins.json"), JSON.stringify(["x"]));
    await new Promise((res) => setTimeout(res, 300));
    expect(fired).toBeGreaterThan(0);
    p.close();
  });

  it("onChange fires via rescan backstop when the file is written directly (container-safe detection)", async () => {
    const r = root();
    const p = new NodeFsCommunityPlugins(r);
    let fired = 0;
    p.onChange(() => {
      fired++;
    });
    // Write directly, bypassing the port — fs.watch may not fire in all environments
    // (e.g. Docker bind-mount / overlayfs). The 2 s rescan backstop must detect it.
    writeFileSync(join(r, ".obsidian/community-plugins.json"), JSON.stringify(["rescan-test"]));
    // Wait longer than the 2 s rescan interval so the timer has fired at least once.
    await new Promise((res) => setTimeout(res, 2_500));
    expect(fired).toBeGreaterThan(0);
    p.close();
  }, 10_000);
});
