import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createServer, assertAuthConfig } from "./index.js";
import { TokenRegistry } from "./token-registry.js";
import type { BlobBackend } from "./file-endpoint.js";

const tmpdirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-createserver-"));
  tmpdirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpdirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// Grab an ephemeral port by briefly binding a throwaway http.Server, then closing
// it. Uses http.Server (not net.Server) to mirror admin.test.ts, whose .listen/
// .address usage typechecks cleanly under this package's tsconfig.
async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  if (addr === null || typeof addr === "string") {
    await new Promise<void>((r) => srv.close(() => r()));
    throw new Error("could not determine ephemeral port");
  }
  const { port } = addr;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function memBackend(): BlobBackend {
  const store = new Map<string, Uint8Array>();
  return {
    async has(sha) {
      return store.has(sha);
    },
    async put(sha, bytes) {
      store.set(sha, bytes);
    },
    async get(sha) {
      const b = store.get(sha);
      if (!b) throw new Error("not found");
      return b;
    },
  };
}

describe("createServer integration — registry-driven auth + admin", () => {
  it("admin mints a token that authenticates the blob endpoint; bogus is rejected", async () => {
    const dir = await tmpDir();
    const registry = TokenRegistry.create({ tokensFile: path.join(dir, "tokens.json") });
    const [relayPort, blobPort, adminPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    const handle = await createServer({
      relayPort,
      blobPort,
      snapshotDir: path.join(dir, "snap"),
      blobBackend: memBackend(),
      registry,
      admin: { port: adminPort, adminToken: "admintok", uiHtml: "<html>ADMIN_UI</html>" },
    });
    const adminBase = `http://127.0.0.1:${adminPort}`;
    const blobBase = `http://127.0.0.1:${blobPort}`;
    try {
      // Admin serves its UI.
      const ui = await fetch(`${adminBase}/`);
      expect(ui.status).toBe(200);
      expect(await ui.text()).toContain("ADMIN_UI");

      // Mint a device token via the admin API.
      const created = (await (
        await fetch(`${adminBase}/api/tokens`, {
          method: "POST",
          headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" },
          body: JSON.stringify({ device: "pc" }),
        })
      ).json()) as { token: string };
      expect(typeof created.token).toBe("string");

      // That token authenticates a blob PUT + GET.
      const bytes = new Uint8Array(Buffer.from("hello integration"));
      const sha = createHash("sha256").update(bytes).digest("hex");
      const put = await fetch(`${blobBase}/blob/${sha}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${created.token}` },
        body: bytes,
      });
      expect(put.status).toBe(201);
      const get = await fetch(`${blobBase}/blob/${sha}`, {
        headers: { Authorization: `Bearer ${created.token}` },
      });
      expect(get.status).toBe(200);

      // A bogus token is rejected by the blob endpoint.
      const bogus = await fetch(`${blobBase}/blob/${sha}`, {
        headers: { Authorization: "Bearer nope" },
      });
      expect(bogus.status).toBe(401);
    } finally {
      await handle.close();
      registry.close(); // idempotent; handle.close() also closes it
    }
  });
});

describe("assertAuthConfig", () => {
  it("rejects single mode with a missing or empty static token", () => {
    expect(() => assertAuthConfig("single", undefined, undefined)).toThrow(/no auth configured/);
    expect(() => assertAuthConfig("single", "", undefined)).toThrow(/no auth configured/);
  });
  it("allows single mode with a non-empty static token (the harness/dev path)", () => {
    expect(() => assertAuthConfig("single", "dev-static-token", undefined)).not.toThrow();
  });
  it("allows file mode regardless of the static token", () => {
    expect(() => assertAuthConfig("file", undefined, undefined)).not.toThrow();
  });
  it("rejects an empty admin token", () => {
    expect(() => assertAuthConfig("file", undefined, "")).toThrow(/ZYNC_ADMIN_TOKEN is empty/);
  });
  it("allows an unset or non-empty admin token", () => {
    expect(() => assertAuthConfig("file", undefined, undefined)).not.toThrow();
    expect(() => assertAuthConfig("file", undefined, "strongtoken")).not.toThrow();
  });
});
