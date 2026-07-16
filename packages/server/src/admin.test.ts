import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAdminHandler, buildStatusProvider, type AdminStatus } from "./admin.js";
import { TokenRegistry } from "./token-registry.js";
import type { DeviceToken, DeviceTokenPublic } from "./token-registry.js";

const tmpdirs: string[] = [];
async function tmpFile(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-admin-"));
  tmpdirs.push(dir);
  return path.join(dir, "tokens.json");
}
afterEach(async () => {
  let dir: string | undefined;
  while ((dir = tmpdirs.pop()) !== undefined) await fsp.rm(dir, { recursive: true, force: true });
});

const USER = "admin";
const PASS = "s3cret";
/** Build an HTTP Basic `Authorization` header for the given credentials. */
const basic = (u: string, p: string) => ({
  Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64"),
});
/** The valid admin credential header used by the happy-path tests. */
const AUTH = basic(USER, PASS);

async function startAdmin(reg: TokenRegistry, user = USER, password = PASS) {
  const status = async (): Promise<AdminStatus> => ({
    uptimeSec: 42,
    deviceCount: reg.deviceCount,
    blobStoreOk: true,
    snapshotCount: 3,
  });
  const handler = createAdminHandler({
    registry: reg,
    adminUser: user,
    adminPassword: password,
    status,
    uiHtml: "<html>ADMIN_UI</html>",
  });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const base = `http://127.0.0.1:${addr.port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("admin handler", () => {
  it("requires Basic auth for GET / (401 + WWW-Authenticate), serves UI when authed", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const s = await startAdmin(reg);
    try {
      const noauth = await fetch(`${s.base}/`);
      expect(noauth.status).toBe(401);
      expect(noauth.headers.get("www-authenticate")).toContain("Basic");
      const res = await fetch(`${s.base}/`, { headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("ADMIN_UI");
    } finally {
      await s.close();
      reg.close();
    }
  });

  it("gates /api/* behind Basic auth (none, wrong user, wrong pass → 401)", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const s = await startAdmin(reg);
    try {
      expect((await fetch(`${s.base}/api/tokens`)).status).toBe(401);
      expect(
        (await fetch(`${s.base}/api/tokens`, { headers: basic("admin", "wrong") })).status,
      ).toBe(401);
      expect(
        (await fetch(`${s.base}/api/tokens`, { headers: basic("wrong", "s3cret") })).status,
      ).toBe(401);
      expect((await fetch(`${s.base}/api/tokens`, { headers: AUTH })).status).toBe(200);
    } finally {
      await s.close();
      reg.close();
    }
  });

  it("creates, lists, and revokes device tokens", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const s = await startAdmin(reg);
    try {
      const created = (await (
        await fetch(`${s.base}/api/tokens`, {
          method: "POST",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body: JSON.stringify({ device: "phone" }),
        })
      ).json()) as DeviceToken;
      expect(created.device).toBe("phone");
      expect(typeof created.token).toBe("string");
      expect(reg.verify(created.token)).toBe(true);

      const list = (await (
        await fetch(`${s.base}/api/tokens`, { headers: AUTH })
      ).json()) as DeviceTokenPublic[];
      expect(list).toHaveLength(1);
      const firstItem = list[0];
      expect(firstItem?.tokenMasked.startsWith("…")).toBe(true);
      expect((firstItem as unknown as Record<string, unknown>).token).toBeUndefined();

      const del = await fetch(`${s.base}/api/tokens/${created.id}`, {
        method: "DELETE",
        headers: AUTH,
      });
      expect(del.status).toBe(200);
      expect(reg.verify(created.token)).toBe(false);
    } finally {
      await s.close();
      reg.close();
    }
  });

  it("returns status", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const s = await startAdmin(reg);
    try {
      const st = await (await fetch(`${s.base}/api/status`, { headers: AUTH })).json();
      expect(st).toEqual({ uptimeSec: 42, deviceCount: 0, blobStoreOk: true, snapshotCount: 3 });
    } finally {
      await s.close();
      reg.close();
    }
  });

  it("rejects a malformed JSON body with 400", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const s = await startAdmin(reg);
    try {
      const res = await fetch(`${s.base}/api/tokens`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await s.close();
      reg.close();
    }
  });

  it("rejects an oversized body with 413", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const s = await startAdmin(reg);
    try {
      const res = await fetch(`${s.base}/api/tokens`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ device: "x".repeat(70000) }),
      });
      expect(res.status).toBe(413);
    } finally {
      await s.close();
      reg.close();
    }
  });

  it("rejects POST with missing/empty device with 400", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const s = await startAdmin(reg);
    try {
      const res = await fetch(`${s.base}/api/tokens`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ device: "" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await s.close();
      reg.close();
    }
  });

  it("returns 404 { removed: false } when revoking an unknown id", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const s = await startAdmin(reg);
    try {
      const res = await fetch(`${s.base}/api/tokens/does-not-exist`, {
        method: "DELETE",
        headers: AUTH,
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ removed: false });
    } finally {
      await s.close();
      reg.close();
    }
  });

  it("maps a throwing status provider to 500 (safety net)", async () => {
    const reg = TokenRegistry.create({ tokensFile: await tmpFile() });
    const handler = createAdminHandler({
      registry: reg,
      adminUser: USER,
      adminPassword: PASS,
      status: async () => {
        throw new Error("boom");
      },
      uiHtml: "<html>ADMIN_UI</html>",
    });
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const res = await fetch(`${base}/api/status`, { headers: AUTH });
      expect(res.status).toBe(500);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      reg.close();
    }
  });
});

describe("buildStatusProvider", () => {
  it("reports counts, uptime, and blob reachability (ok + unreachable)", async () => {
    const dir = path.dirname(await tmpFile());
    await fsp.writeFile(path.join(dir, "a.bin"), "x");
    await fsp.writeFile(path.join(dir, "b.bin"), "y");
    await fsp.writeFile(path.join(dir, "notes.txt"), "z");
    const reg = TokenRegistry.create({ tokensFile: path.join(dir, "tokens.json") });
    reg.add("pc");
    const okBackend = {
      has: async () => true,
      get: async (): Promise<Uint8Array> => new Uint8Array(),
      put: async (): Promise<void> => {
        /* no-op stub */
      },
    };
    const okStatus = buildStatusProvider({
      registry: reg,
      blobBackend: okBackend,
      snapshotDir: dir,
      startedAt: 1000,
      now: () => 6000,
    });
    expect(await okStatus()).toEqual({
      uptimeSec: 5,
      deviceCount: 1,
      blobStoreOk: true,
      snapshotCount: 2,
    });

    const failBackend = {
      has: async (): Promise<boolean> => {
        throw new Error("down");
      },
      get: async (): Promise<Uint8Array> => new Uint8Array(),
      put: async (): Promise<void> => {
        /* no-op stub */
      },
    };
    const failStatus = buildStatusProvider({
      registry: reg,
      blobBackend: failBackend,
      snapshotDir: dir,
      startedAt: 1000,
      now: () => 6000,
    });
    expect((await failStatus()).blobStoreOk).toBe(false);
    reg.close();
  });
});
