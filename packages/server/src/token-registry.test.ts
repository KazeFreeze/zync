import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TokenRegistry } from "./token-registry.js";

const tmpdirs: string[] = [];
async function tmpFile(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-tokreg-"));
  tmpdirs.push(dir);
  return path.join(dir, "tokens.json");
}
afterEach(async () => {
  let dir: string | undefined;
  while ((dir = tmpdirs.pop()) !== undefined) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// Deterministic injectables for TDD.
function fixedOpts(tokensFile?: string) {
  let n = 0;
  return {
    ...(tokensFile !== undefined ? { tokensFile } : {}),
    now: () => "2026-07-15T00:00:00.000Z",
    genToken: () => `tok${(++n).toString().padStart(2, "0")}`,
    genId: () => `id${n.toString().padStart(2, "0")}`,
  };
}

describe("TokenRegistry — single-token fallback", () => {
  it("verifies the static token and nothing else; CRUD throws", () => {
    const reg = TokenRegistry.create({ staticToken: "s3cret" });
    expect(reg.mode).toBe("single");
    expect(reg.verify("s3cret")).toBe(true);
    expect(reg.verify("nope")).toBe(false);
    expect(reg.getDevice("s3cret")).toBe("relay");
    expect(reg.list()).toEqual([]);
    expect(reg.deviceCount).toBe(0);
    expect(() => reg.add("pc")).toThrow(/not configured/);
    expect(() => reg.remove("id01")).toThrow(/not configured/);
    reg.close();
  });
});

describe("TokenRegistry — file mode", () => {
  it("absent file starts empty; add() creates it and grants access", async () => {
    const f = await tmpFile();
    const reg = TokenRegistry.create(fixedOpts(f));
    expect(reg.mode).toBe("file");
    expect(reg.verify("anything")).toBe(false);
    const entry = reg.add("pc-home");
    expect(entry).toEqual({
      id: "id01",
      token: "tok01",
      device: "pc-home",
      created: "2026-07-15T00:00:00.000Z",
    });
    expect(reg.verify("tok01")).toBe(true);
    expect(reg.getDevice("tok01")).toBe("pc-home");
    expect(reg.deviceCount).toBe(1);
    const onDisk = JSON.parse(await fsp.readFile(f, "utf8"));
    expect(onDisk).toEqual([entry]);
    reg.close();
  });

  it("list() masks tokens; remove() revokes by id", async () => {
    const f = await tmpFile();
    const reg = TokenRegistry.create(fixedOpts(f));
    reg.add("pc");
    reg.add("phone");
    expect(reg.list()).toEqual([
      { id: "id01", device: "pc", created: "2026-07-15T00:00:00.000Z", tokenMasked: "…tok01" },
      { id: "id02", device: "phone", created: "2026-07-15T00:00:00.000Z", tokenMasked: "…tok02" },
    ]);
    expect(reg.remove("id01")).toBe(true);
    expect(reg.verify("tok01")).toBe(false);
    expect(reg.verify("tok02")).toBe(true);
    expect(reg.remove("id-missing")).toBe(false);
    reg.close();
  });

  it("persists across instances", async () => {
    const f = await tmpFile();
    const a = TokenRegistry.create(fixedOpts(f));
    const created = a.add("pc");
    a.close();
    const b = TokenRegistry.create({ tokensFile: f });
    expect(b.verify(created.token)).toBe(true);
    expect(b.deviceCount).toBe(1);
    b.close();
  });

  it("throws on a corrupt file at startup (fail-closed)", async () => {
    const f = await tmpFile();
    await fsp.writeFile(f, "{ not json");
    expect(() => TokenRegistry.create({ tokensFile: f })).toThrow(/tokens\.json/);
  });

  it("throws on a malformed entry at startup; empty array is valid", async () => {
    const f = await tmpFile();
    await fsp.writeFile(f, JSON.stringify([{ device: "x" }]));
    expect(() => TokenRegistry.create({ tokensFile: f })).toThrow(/tokens\.json/);

    await fsp.writeFile(f, "[]");
    const reg = TokenRegistry.create({ tokensFile: f });
    expect(reg.deviceCount).toBe(0);
    reg.close();
  });
});

describe("TokenRegistry — hot reload", () => {
  it("picks up an external edit to tokens.json", async () => {
    const f = await tmpFile();
    const writer = TokenRegistry.create(fixedOpts(f));
    const reader = TokenRegistry.create({ tokensFile: f });
    reader.watch();
    const entry = writer.add("phone"); // writes the file
    await vi.waitFor(() => expect(reader.verify(entry.token)).toBe(true), { timeout: 3000 });
    expect(reader.deviceCount).toBe(1);
    reader.close();
    writer.close();
  });

  it("keeps the last-good set when the file becomes corrupt", async () => {
    const f = await tmpFile();
    const reg = TokenRegistry.create(fixedOpts(f));
    const entry = reg.add("pc");
    reg.watch();
    await fsp.writeFile(f, "{ corrupt");
    // Give the watcher a beat; the good token must still verify.
    await new Promise((r) => setTimeout(r, 400));
    expect(reg.verify(entry.token)).toBe(true);
    reg.close();
  });
});
