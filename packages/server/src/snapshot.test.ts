/**
 * snapshot.test.ts — unit tests for SnapshotStore.
 *
 * Tests the save→reload round-trip and missing→null contract
 * against a real temp directory.
 */

import { describe, it, expect } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SnapshotStore } from "./snapshot.js";
import { readdirSync } from "node:fs";

async function makeTmpStore(): Promise<{ store: SnapshotStore; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-snapshot-test-"));
  return { store: new SnapshotStore(dir), dir };
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

describe("SnapshotStore — save / load", () => {
  it("save then load round-trips bytes", async () => {
    const { store } = await makeTmpStore();
    const bytes = enc("yjs-update-bytes");
    await store.save("my-doc", bytes);
    const loaded = await store.load("my-doc");
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("yjs-update-bytes");
  });

  it("load returns null for an unknown doc name", async () => {
    const { store } = await makeTmpStore();
    expect(await store.load("never-saved")).toBeNull();
  });

  it("save is idempotent — last write wins", async () => {
    const { store } = await makeTmpStore();
    await store.save("doc-x", enc("v1"));
    await store.save("doc-x", enc("v2"));
    const loaded = await store.load("doc-x");
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("v2");
  });

  it("handles special chars in doc name (e.g. __zync_index__)", async () => {
    const { store } = await makeTmpStore();
    const bytes = enc("index-bytes");
    await store.save("__zync_index__", bytes);
    const loaded = await store.load("__zync_index__");
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("index-bytes");
  });

  it("handles slashes in doc name (vault path as doc name)", async () => {
    const { store } = await makeTmpStore();
    const bytes = enc("slashy-bytes");
    await store.save("vault/notes/foo.md", bytes);
    const loaded = await store.load("vault/notes/foo.md");
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("slashy-bytes");
  });

  it("different doc names produce different stored files", async () => {
    const { store } = await makeTmpStore();
    await store.save("doc-a", enc("aaa"));
    await store.save("doc-b", enc("bbb"));
    const a = await store.load("doc-a");
    const b = await store.load("doc-b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a !== null && b !== null) {
      expect(dec(a)).toBe("aaa");
      expect(dec(b)).toBe("bbb");
    }
  });

  it("persists across store re-instantiation (same dir, new SnapshotStore)", async () => {
    const { dir } = await makeTmpStore();
    const store1 = new SnapshotStore(dir);
    await store1.save("persist-me", enc("persisted"));

    const store2 = new SnapshotStore(dir);
    const loaded = await store2.load("persist-me");
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(dec(loaded)).toBe("persisted");
  });

  it("save creates the snapshot dir if it does not exist", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-snap-base-"));
    const nestedDir = path.join(base, "sub", "dir");
    const store = new SnapshotStore(nestedDir);
    await store.save("doc", enc("bytes"));
    const loaded = await store.load("doc");
    expect(loaded).not.toBeNull();
  });

  it("round-trips binary (non-UTF8) bytes", async () => {
    const { store } = await makeTmpStore();
    // Simulate opaque Yjs update bytes — arbitrary binary.
    const binary = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe, 0xab]);
    await store.save("binary-doc", binary);
    const loaded = await store.load("binary-doc");
    expect(loaded).not.toBeNull();
    if (loaded !== null) expect(Array.from(loaded)).toEqual(Array.from(binary));
  });

  // -------------------------------------------------------------------------
  // safeName collision guard (fix #2)
  // -------------------------------------------------------------------------
  it("two long doc names sharing a long common prefix produce different filenames and round-trip independently", async () => {
    // Construct two names that share the first 250 chars (well past the 200-char
    // base64url truncation point), differing only in the last byte.
    const sharedPrefix = "x".repeat(250);
    const nameA = sharedPrefix + "A";
    const nameB = sharedPrefix + "B";

    const { store, dir } = await makeTmpStore();
    await store.save(nameA, enc("payload-for-A"));
    await store.save(nameB, enc("payload-for-B"));

    // Both must round-trip to their own payloads (proves they map to different files).
    const loadedA = await store.load(nameA);
    const loadedB = await store.load(nameB);
    expect(loadedA).not.toBeNull();
    expect(loadedB).not.toBeNull();
    if (loadedA !== null) expect(dec(loadedA)).toBe("payload-for-A");
    if (loadedB !== null) expect(dec(loadedB)).toBe("payload-for-B");

    // Confirm they physically occupy two distinct .bin files.
    const binFiles = readdirSync(dir).filter((f) => f.endsWith(".bin"));
    expect(binFiles.length).toBe(2);
  });
});
