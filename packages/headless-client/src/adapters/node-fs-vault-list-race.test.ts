/**
 * `NodeFsVault.list()` vs. a CONCURRENT DELETE.
 *
 * `walk()` readdirs a directory and then stats each entry in turn. A delete landing in that window
 * — a peer's remote delete materializing while something scans the vault — removes the file out
 * from under the pending stat. The directory-level readdir already tolerates ENOENT; the per-entry
 * stat did not, so ONE vanished file aborted the WHOLE listing.
 *
 * Observed for real, not theoretical: during the full harness suite `GET /fs/tree` returned
 * `500 ENOENT ... stat '/vault/notes/gone.md'` while device-b's delete was being applied to
 * device-a, which failed the run. It passed in isolation — only sustained load widened the window.
 *
 * Lives in its OWN file because it needs a module-level mock of `node:fs/promises` to make the
 * race deterministic (the ESM namespace is frozen, so `vi.spyOn` cannot redefine `stat`).
 */

import { describe, it, expect, vi } from "vitest";

/** Delete the target the instant its stat is attempted — exactly the readdir→stat window. */
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    stat: async (target: unknown, ...rest: unknown[]) => {
      if (typeof target === "string" && target.endsWith("vanishes.md")) {
        await actual.rm(target, { force: true });
      }
      return (actual.stat as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    },
  };
});

const fsp = await import("node:fs/promises");
const path = await import("node:path");
const os = await import("node:os");
const { NodeFsVault } = await import("./node-fs-vault.js");

describe("NodeFsVault — list() races a concurrent delete", () => {
  it("skips a file that vanishes between readdir and stat instead of failing the listing", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-vault-race-"));
    const vault = new NodeFsVault(dir);
    try {
      await fsp.mkdir(path.join(dir, "notes"), { recursive: true });
      await fsp.writeFile(path.join(dir, "notes", "keep.md"), "keep");
      await fsp.writeFile(path.join(dir, "notes", "vanishes.md"), "gone soon");

      const listed = await vault.list();

      expect(listed.map((e) => e.path)).toEqual(["notes/keep.md"]);
    } finally {
      vault.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
