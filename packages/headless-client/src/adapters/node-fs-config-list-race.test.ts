/**
 * `NodeFsConfig.list()` vs. a concurrent plugin rewrite.
 *
 * The directory entry can vanish after `readdir` but before its per-entry `stat`. A plugin replacing
 * its own bundle during engine startup must not reject the whole config listing and abort note sync.
 * This separate file provides the module-level mock required to make that TOCTOU race deterministic.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    stat: async (target: unknown, ...rest: unknown[]) => {
      if (typeof target === "string" && target.endsWith("vanishes.css")) {
        await actual.rm(target, { force: true });
      }
      return (actual.stat as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    },
  };
});

const fsp = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");
const { NodeFsConfig } = await import("./node-fs-config.js");

describe("NodeFsConfig — list() races a concurrent plugin rewrite", () => {
  it("skips a config file that vanishes between readdir and stat instead of aborting startup", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-config-race-"));
    const config = new NodeFsConfig(dir);
    try {
      const snippets = path.join(dir, ".obsidian", "snippets");
      await fsp.mkdir(snippets, { recursive: true });
      await fsp.writeFile(path.join(snippets, "keep.css"), "keep");
      await fsp.writeFile(path.join(snippets, "vanishes.css"), "gone soon");

      const listed = await config.list();

      expect(listed.map((entry) => entry.path)).toEqual([".obsidian/snippets/keep.css"]);
    } finally {
      config.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
