/**
 * In-process integration tests for the headless-client daemon + control API (0b-3 Task 1b).
 *
 * A SINGLE daemon runs with the transport OFFLINE (`connect: false`) so `start()` bootstraps
 * + seeds locally with no relay. The control API is mounted on an ephemeral port and driven
 * over `fetch`, exactly as the Docker harness will. Full cross-device convergence needs the
 * relay (a later Docker task) and is NOT attempted here.
 *
 * The NodeFsVault watcher is asynchronous (coalesce + fs.stat), so external writes are
 * awaited via {@link waitForIngest} (poll ingestCount), THEN `/sync/flush` drains the engine.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createDaemon, configFromEnv, type Daemon, type DaemonConfig } from "./daemon.js";

let daemon: Daemon | null = null;
let baseUrl = "";
let fixturesDir = "";
const tmpDirs: string[] = [];

async function makeTmpDir(label: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `zync-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

/** Boot an idle daemon (offline transport) and start its HTTP server on an ephemeral port. */
async function boot(overrides: Partial<DaemonConfig> = {}): Promise<void> {
  const vaultDir = await makeTmpDir("vault");
  const configDir = path.join(vaultDir, ".obsidian", "zync");
  fixturesDir = await makeTmpDir("fixtures");
  const config: DaemonConfig = {
    vaultDir,
    configDir,
    engineConfigDir: ".obsidian/zync",
    docStoreDir: path.join(configDir, "docstore"),
    stateFile: path.join(configDir, "engine-state.json"),
    fixturesDir,
    deviceId: "device-test",
    deviceName: "test",
    serverWs: "ws://localhost:0",
    serverHttp: "http://localhost:0",
    port: 0, // ephemeral
    maxProseBytes: 1_000_000,
    ingestDisabled: false,
    connect: false, // OFFLINE — no relay
    ...overrides,
  };
  daemon = await createDaemon(config);
  const port = await daemon.listen();
  baseUrl = `http://127.0.0.1:${String(port)}`;
}

afterEach(async () => {
  if (daemon !== null) {
    await daemon.close();
    daemon = null;
  }
  for (const dir of tmpDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── fetch helpers ────────────────────────────────────────────────────────────

async function post(route: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${route}`, init);
  const json: unknown = await res.json();
  return { status: res.status, json };
}

async function get(route: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${route}`);
  const json: unknown = await res.json();
  return { status: res.status, json };
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Poll until ingestCount reaches `target` (watcher is async), then flush the engine. */
async function waitForIngest(target: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await get("/status");
    const count = (json as { ingestCount: number }).ingestCount;
    if (count >= target) break;
    if (Date.now() > deadline)
      throw new Error(`ingestCount stuck at ${String(count)} (<${String(target)})`);
    await new Promise((r) => setTimeout(r, 25));
  }
  await post("/sync/flush");
  await post("/sync/flush"); // a second drain settles any chained reconcile
}

// ── helpers to write a fixture on disk ─────────────────────────────────────────

async function writeFixtureFile(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

describe("headless-client daemon control API", () => {
  beforeEach(() => {
    // each test boots its own daemon
  });

  it("/vault/load → /sync/start → /fs/tree reflects loaded files (offline bootstrap)", async () => {
    await boot();
    await writeFixtureFile(fixturesDir, "basic/note-a.md", "Hello A\n");
    await writeFixtureFile(fixturesDir, "basic/sub/note-b.md", "Hello B\n");

    const load = await post("/vault/load", { fixture: "basic" });
    expect(load.status).toBe(200);
    expect((load.json as { fileCount: number }).fileCount).toBe(2);

    const start = await post("/sync/start");
    expect(start.status).toBe(200);
    await post("/sync/flush");

    const tree = (await get("/fs/tree")).json as Record<string, { sha256: string; size: number }>;
    expect(Object.keys(tree).sort()).toEqual(["note-a.md", "sub/note-b.md"]);
    expect(tree["note-a.md"]?.size).toBe("Hello A\n".length);
  });

  it("/vault/load is rejected AFTER /sync/start (boot-idle contract)", async () => {
    await boot();
    await post("/sync/start");
    const load = await post("/vault/load", { fixture: "anything" });
    expect(load.status).toBe(409);
  });

  it("external /fs/write of a prose file → ingested into a doc with a base hash", async () => {
    await boot();
    await post("/sync/start");
    await post("/fs/write", { path: "notes/x.md", contentBase64: b64("# Title\n\nbody\n") });
    await waitForIngest(1);

    const doc = (await get("/doc?path=notes/x.md")).json as {
      docId: string | null;
      text: string;
      contentSha256: string;
      baseHash: string | null;
      fsmState: string;
    };
    expect(doc.docId).not.toBeNull();
    expect(doc.text).toBe("# Title\n\nbody\n");
    expect(doc.baseHash).not.toBeNull();
    expect(doc.fsmState).toBe("inactive");

    const status = (await get("/status")).json as { ingestCount: number };
    expect(status.ingestCount).toBeGreaterThanOrEqual(1);
  });

  it("/editor/open → active-bound; editor type + external write MERGE (both survive)", async () => {
    await boot();
    await post("/sync/start");
    // Seed a 3-line note and ingest it.
    await post("/fs/write", { path: "n.md", contentBase64: b64("L1\nL2\nL3\n") });
    await waitForIngest(1);

    // Open an editor on the note → active-bound.
    const open = await post("/editor/open", { path: "n.md" });
    expect(open.status).toBe(200);
    expect((open.json as { fsmState: string }).fsmState).toBe("active-bound");

    const docAfterOpen = (await get("/doc?path=n.md")).json as { fsmState: string; text: string };
    expect(docAfterOpen.fsmState).toBe("active-bound");
    expect(docAfterOpen.text).toBe("L1\nL2\nL3\n");

    // Editor replaces L3 → "CRDT" (origin local-editor): doc becomes "L1\nL2\nCRDT\n".
    const ed = await post("/editor/type", { path: "n.md", at: 6, del: 2, ins: "CRDT" });
    expect(ed.status).toBe(200);

    // EXTERNAL write rewrites line 1 (disjoint) → active-bound 3-way merge.
    const ingestBefore = (await get("/status")).json as { ingestCount: number };
    await post("/fs/write", { path: "n.md", contentBase64: b64("DISK\nL2\nL3\n") });
    await waitForIngest(ingestBefore.ingestCount + 1);

    const merged = (await get("/doc?path=n.md")).json as { text: string };
    // Active-bound merge: both edits survive (mirrors active-bound.test.ts).
    expect(merged.text).toBe("DISK\nL2\nCRDT\n");

    const close = await post("/editor/close", { path: "n.md" });
    expect((close.json as { fsmState: string }).fsmState).toBe("inactive");
  });

  it("/fs/rename → new path keeps the SAME docId; old path 404s or is tombstoned", async () => {
    await boot();
    await post("/sync/start");
    await post("/fs/write", { path: "old.md", contentBase64: b64("keep me\n") });
    await waitForIngest(1);

    const before = (await get("/doc?path=old.md")).json as { docId: string | null };
    expect(before.docId).not.toBeNull();

    await post("/fs/rename", { from: "old.md", to: "new.md" });
    await post("/sync/flush");

    const after = (await get("/doc?path=new.md")).json as {
      docId: string | null;
      text: string;
      deleted: boolean | null;
      live: boolean;
    };
    expect(after.docId).toBe(before.docId); // docId continuity across rename
    expect(after.text).toBe("keep me\n");
    // The renamed entry is LIVE (not tombstoned by un-quarantined watcher fallout).
    expect(after.live).toBe(true);
    expect(after.deleted).not.toBe(true);

    // The renamed file is MATERIALIZED ON DISK at the new path (the rename-transaction
    // bug: pre-fix the real recursive watcher fallout stranded it). Asserted via /fs/tree
    // (the real on-disk listing), not just the index/CRDT.
    const tree = (await get("/fs/tree")).json as Record<string, unknown>;
    expect(Object.keys(tree)).toContain("new.md");
    expect(Object.keys(tree)).not.toContain("old.md");

    // Old path: file gone from disk; index entry tombstoned (no live doc) or 404.
    const old = await get("/doc?path=old.md");
    if (old.status === 200) {
      expect((old.json as { live: boolean }).live).toBe(false);
    } else {
      expect(old.status).toBe(404);
    }
  });

  it("/fs/delete → file gone from /fs/tree", async () => {
    await boot();
    await post("/sync/start");
    await post("/fs/write", { path: "gone.md", contentBase64: b64("bye\n") });
    await waitForIngest(1);

    let tree = (await get("/fs/tree")).json as Record<string, unknown>;
    expect(Object.keys(tree)).toContain("gone.md");

    const ingestBefore = (await get("/status")).json as { ingestCount: number };
    await post("/fs/delete", { path: "gone.md" });
    // delete is not counted in ingestCount; poll the tree directly.
    const deadline = Date.now() + 5000;
    for (;;) {
      tree = (await get("/fs/tree")).json as Record<string, unknown>;
      if (!Object.keys(tree).includes("gone.md")) break;
      if (Date.now() > deadline) throw new Error("file never disappeared from tree");
      await new Promise((r) => setTimeout(r, 25));
    }
    await post("/sync/flush");
    expect(Object.keys(tree)).not.toContain("gone.md");
    // ingestCount unchanged by a delete.
    const after = (await get("/status")).json as { ingestCount: number };
    expect(after.ingestCount).toBe(ingestBefore.ingestCount);
  });

  it("/fs/edit append → ingested updated text", async () => {
    await boot();
    await post("/sync/start");
    await post("/fs/write", { path: "e.md", contentBase64: b64("line1\n") });
    await waitForIngest(1);

    const ingestBefore = (await get("/status")).json as { ingestCount: number };
    await post("/fs/edit", { path: "e.md", append: "line2\n" });
    await waitForIngest(ingestBefore.ingestCount + 1);

    const doc = (await get("/doc?path=e.md")).json as { text: string };
    expect(doc.text).toBe("line1\nline2\n");
    const status = (await get("/status")).json as { writeCount: number };
    expect(status.writeCount).toBe(2); // one write + one edit
  });

  it("/metrics returns plausible numbers", async () => {
    await boot();
    await post("/sync/start");
    await post("/fs/write", { path: "m.md", contentBase64: b64("metrics\n") });
    await waitForIngest(1);

    const m = (await get("/metrics")).json as {
      rssMb: number;
      docStoreBytes: number;
      indexDocBytes: number;
      attachedDocs: number;
    };
    expect(m.rssMb).toBeGreaterThan(0);
    expect(m.attachedDocs).toBeGreaterThanOrEqual(0);
    expect(m.indexDocBytes).toBeGreaterThan(0);
    expect(m.docStoreBytes).toBeGreaterThanOrEqual(0);
  });

  it("/doc 404s for an unknown path with no file", async () => {
    await boot();
    await post("/sync/start");
    const res = await get("/doc?path=nope.md");
    expect(res.status).toBe(404);
  });

  it("configFromEnv: blobPolicy defaults to eager and reads ZYNC_BLOB_POLICY", () => {
    // Default: the headless FOLLOWER must eagerly materialize synced blobs to disk
    // (Fix 3) — otherwise a blob reaches the server store but never lands on the device.
    expect(configFromEnv({}).blobPolicy).toBe("eager");
    // Explicit override flows through.
    expect(configFromEnv({ ZYNC_BLOB_POLICY: "lazy" }).blobPolicy).toBe("lazy");
    expect(configFromEnv({ ZYNC_BLOB_POLICY: "eager" }).blobPolicy).toBe("eager");
  });

  it("projector mode (ingestDisabled) → external write does NOT create a doc; ingestCount stays 0", async () => {
    await boot({ ingestDisabled: true });
    await post("/sync/start");
    await post("/fs/write", { path: "proj.md", contentBase64: b64("projected\n") });

    // The watcher fires but the engine early-returns (ingestDisabled). We cannot use
    // waitForIngest (which polls ingestCount — it will never increment in projector mode).
    // Instead, poll the filesystem tree directly until the file appears (watcher settled).
    const deadline = Date.now() + 5000;
    for (;;) {
      const tree = (await get("/fs/tree")).json as Record<string, unknown>;
      if (Object.keys(tree).includes("proj.md")) break;
      if (Date.now() > deadline) throw new Error("file never appeared in /fs/tree");
      await new Promise((r) => setTimeout(r, 25));
    }
    await post("/sync/flush");

    // The file IS on disk (external write), but there is NO index entry / doc text
    // from the engine: /doc returns the DISK text with a null docId (no ingest).
    const doc = (await get("/doc?path=proj.md")).json as {
      docId: string | null;
      text: string;
    };
    expect(doc.docId).toBeNull(); // ingest disabled → no index entry
    expect(doc.text).toBe("projected\n"); // disk fallback still reads the file

    const statusBody = (await get("/status")).json as {
      pendingDocs: number;
      ingestCount: number;
    };
    expect(statusBody.pendingDocs).toBe(0); // nothing ingested → nothing pending
    // ingestCount must be 0: the counter only increments when ingest actually happens.
    expect(statusBody.ingestCount).toBe(0);
  });
});

describe("headless-client daemon — durability-trust wiring", () => {
  it("defaults to a durability-TRUSTED vault (a real local FS root)", async () => {
    await boot();
    if (daemon === null) throw new Error("daemon not booted");
    expect(daemon.vault.durabilityTrusted()).toBe(true);
  });

  it("config.durabilityTrusted=false constructs a NON-trusted vault (FUSE/cloud root)", async () => {
    await boot({ durabilityTrusted: false });
    if (daemon === null) throw new Error("daemon not booted");
    expect(daemon.vault.durabilityTrusted()).toBe(false);
  });

  it("configFromEnv: ZYNC_DURABILITY_TRUSTED=false -> durabilityTrusted false", () => {
    expect(configFromEnv({ ZYNC_DURABILITY_TRUSTED: "false" }).durabilityTrusted).toBe(false);
  });

  it("configFromEnv: unset -> durabilityTrusted true (trust a real local root by default)", () => {
    expect(configFromEnv({}).durabilityTrusted).toBe(true);
  });
});
