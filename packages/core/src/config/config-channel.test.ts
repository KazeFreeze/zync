import { describe, it, expect, vi } from "vitest";
import { ConfigChannel } from "./config-channel.js";
import { sha256OfBytes } from "../hash.js";
import type { CrdtMap, BlobStorePort, ConfigPort, IdentityPort, Unsubscribe } from "../ports.js";
import type { ConfigEntry } from "./config-entry.js";
import type { EchoLedger } from "../bridge/echo.js";

/**
 * Poll until `fn()` throws no errors or `timeoutMs` elapses.
 * Needed because `void handler(path)` discards the promise, and
 * `crypto.subtle.digest` resolves in the I/O phase (after setTimeout(0)) in Node.js.
 */
async function poll(fn: () => void, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

// Minimal in-memory CrdtMap for tests (same pattern as routed-manifest.test.ts).
function memMap<V>(): CrdtMap<V> & { fire: (keys: string[]) => void } {
  const m = new Map<string, V>();
  const subs = new Set<(k: string[]) => void>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
    },
    delete: (k) => {
      m.delete(k);
    },
    entries: () => [...m.entries()],
    observe(cb): Unsubscribe {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    fire: (keys) => {
      subs.forEach((cb) => {
        cb(keys);
      });
    },
  };
}

function makeChannel(enabledCategories = { themes: true, snippets: true }) {
  const config = memMap<ConfigEntry>();

  const blobHas = vi.fn(() => Promise.resolve(false));
  const blobPut = vi.fn(() => Promise.resolve());
  const blobGet = vi.fn(() => Promise.resolve(new Uint8Array()));
  const blobStore: BlobStorePort = {
    has: blobHas,
    put: blobPut,
    get: blobGet,
  };

  let onChangeCb: ((path: string) => void) | undefined;
  const configRemove = vi.fn(() => Promise.resolve());
  const configRead = vi.fn(() => Promise.resolve(null as Uint8Array | null));
  const configList = vi.fn(() => Promise.resolve([] as { path: string; size: number }[]));
  const configPort: ConfigPort = {
    read: configRead,
    writeAtomic: vi.fn(() => Promise.resolve()),
    remove: configRemove,
    list: configList as unknown as ConfigPort["list"],
    onChange: (cb) => {
      onChangeCb = cb as (path: string) => void;
      return () => {
        onChangeCb = undefined;
      };
    },
    rescan: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  };

  const deviceId = vi.fn(() => "d" as never);
  const identity: IdentityPort = {
    deviceId,
    deviceName: vi.fn(() => "dev"),
  };

  const echoRecordWrite = vi.fn(() => undefined);
  const echoIsEcho = vi.fn(() => false);
  const echo = {
    recordWrite: echoRecordWrite,
    isEcho: echoIsEcho,
    clear: vi.fn(),
  } as unknown as EchoLedger;

  const ch = new ConfigChannel({
    config,
    blobStore,
    configPort,
    identity,
    echo,
    enabledCategories,
  });
  return {
    ch,
    config,
    blobHas,
    blobPut,
    blobGet,
    configRemove,
    configRead,
    configList,
    echoRecordWrite,
    echoIsEcho,
    fireOnChange: (path: string) => {
      onChangeCb?.(path);
    },
  };
}

describe("ConfigChannel", () => {
  it("local add: onChange with bytes publishes entry and stores blob", async () => {
    const { ch, config, blobPut, configRead, echoIsEcho, fireOnChange } = makeChannel();
    const bytes = new Uint8Array([1, 2, 3]);
    const expectedSha = await sha256OfBytes(bytes);
    configRead.mockResolvedValue(bytes);
    echoIsEcho.mockReturnValue(false);

    ch.start();
    fireOnChange(".obsidian/snippets/x.css");

    // crypto.subtle.digest resolves through the I/O phase (after setTimeout(0)) in Node.js;
    // waitFor polls until the assertion passes.
    await poll(() => {
      expect(blobPut).toHaveBeenCalledWith(expectedSha, bytes);
    });
    const entry = config.get(".obsidian/snippets/x.css");
    expect(entry).toMatchObject({
      sha256: expectedSha,
      size: 3,
      category: "snippets",
      deviceId: "d",
    });
  });

  it("echo skip: onChange for path whose bytes hash matches echo is ignored", async () => {
    const { ch, config, blobPut, configRead, echoIsEcho, fireOnChange } = makeChannel();
    const bytes = new Uint8Array([4, 5, 6]);
    configRead.mockResolvedValue(bytes);
    echoIsEcho.mockReturnValue(true); // our own materialize wrote this file

    ch.start();
    fireOnChange(".obsidian/snippets/y.css");

    // Poll until echo.isEcho has been called, proving the full async chain ran
    await poll(() => {
      expect(echoIsEcho).toHaveBeenCalled();
    });

    expect(blobPut).not.toHaveBeenCalled();
    expect(config.get(".obsidian/snippets/y.css")).toBeUndefined();
  });

  it("idempotent publish: identical bytes called twice stores blob once", async () => {
    const { ch, blobPut, blobHas } = makeChannel();
    const bytes = new Uint8Array([7, 8, 9]);
    const expectedSha = await sha256OfBytes(bytes);

    await ch.publish(".obsidian/snippets/z.css" as never, bytes);
    expect(blobPut).toHaveBeenCalledTimes(1);

    // Second publish with same bytes: config already has that sha, no-op churn guard fires
    blobHas.mockResolvedValue(true); // blob is now in store
    await ch.publish(".obsidian/snippets/z.css" as never, bytes);
    // blobPut should still be 1 (no second call) because the churn guard exits early
    expect(blobPut).toHaveBeenCalledTimes(1);
    // Confirm the sha is what we expect
    expect(blobPut).toHaveBeenCalledWith(expectedSha, bytes);
  });

  it("local delete -> tombstone: onChange with null read sets deleted:true", async () => {
    const { ch, config, configRead, fireOnChange } = makeChannel();
    const existingEntry: ConfigEntry = {
      sha256: "abc123" as never,
      size: 5,
      category: "snippets",
      deviceId: "d" as never,
    };
    config.set(".obsidian/snippets/x.css", existingEntry);
    configRead.mockResolvedValue(null);

    ch.start();
    fireOnChange(".obsidian/snippets/x.css");

    // configPort.read returns null (Promise.resolve) — no crypto involved, but waitFor is safe
    await poll(() => {
      const entry = config.get(".obsidian/snippets/x.css");
      expect(entry?.deleted).toBe(true);
    });
  });

  it("local delete echo skip: onChange with null read on already-tombstoned entry does nothing further", async () => {
    const { ch, config, configRead, fireOnChange } = makeChannel();
    const tombstonedEntry: ConfigEntry = {
      sha256: "abc123" as never,
      size: 5,
      category: "snippets",
      deviceId: "d" as never,
      deleted: true,
    };
    config.set(".obsidian/snippets/x.css", tombstonedEntry);
    configRead.mockResolvedValue(null);

    ch.start();
    fireOnChange(".obsidian/snippets/x.css");

    // Wait for the async handler to complete (Promise.resolve fast path; no crypto here)
    await new Promise((r) => setTimeout(r, 50));

    // Still deleted, no further modification (the pre-existing tombstone is unchanged)
    const entry = config.get(".obsidian/snippets/x.css");
    expect(entry).toEqual(tombstonedEntry);
  });

  it("remote tombstone -> remove: fire deleted entry triggers configPort.remove and echo.recordWrite", async () => {
    const { ch, config, configRemove, echoRecordWrite } = makeChannel();
    ch.start();

    const entry: ConfigEntry = {
      sha256: "abc123" as never,
      size: 5,
      category: "snippets",
      deviceId: "d" as never,
      deleted: true,
    };
    config.set(".obsidian/snippets/x.css", entry);
    config.fire([".obsidian/snippets/x.css"]);

    // Remote tombstone path only awaits configPort.remove (Promise.resolve) — no crypto
    await poll(() => {
      expect(echoRecordWrite).toHaveBeenCalledWith(".obsidian/snippets/x.css", "abc123");
      expect(configRemove).toHaveBeenCalledWith(".obsidian/snippets/x.css");
    });
  });

  it("bootstrap: list returns two paths, both are published to config", async () => {
    const { ch, config, blobPut, configRead, configList } = makeChannel();
    const bytes1 = new Uint8Array([10, 11]);
    const bytes2 = new Uint8Array([20, 21]);
    const sha1 = await sha256OfBytes(bytes1);
    const sha2 = await sha256OfBytes(bytes2);

    configList.mockResolvedValue([
      { path: ".obsidian/snippets/a.css", size: 2 },
      { path: ".obsidian/themes/b.css", size: 2 },
    ]);
    configRead.mockResolvedValueOnce(bytes1).mockResolvedValueOnce(bytes2);

    await ch.bootstrap();

    expect(config.get(".obsidian/snippets/a.css")).toMatchObject({
      sha256: sha1,
      category: "snippets",
    });
    expect(config.get(".obsidian/themes/b.css")).toMatchObject({
      sha256: sha2,
      category: "themes",
    });
    expect(blobPut).toHaveBeenCalledTimes(2);
  });

  describe("enabledCategories policy", () => {
    it("publish: themes-disabled device does NOT upload a theme file", async () => {
      const { ch, config, blobPut } = makeChannel({ themes: false, snippets: true });
      const bytes = new Uint8Array([1, 2, 3]);

      await ch.publish(".obsidian/themes/Foo/theme.css" as never, bytes);

      expect(blobPut).not.toHaveBeenCalled();
      expect(config.get(".obsidian/themes/Foo/theme.css")).toBeUndefined();
    });

    it("publish: snippets-enabled device DOES upload a snippet file when themes off", async () => {
      const { ch, config, blobPut } = makeChannel({ themes: false, snippets: true });
      const bytes = new Uint8Array([4, 5, 6]);
      const expectedSha = await sha256OfBytes(bytes);

      await ch.publish(".obsidian/snippets/x.css" as never, bytes);

      expect(blobPut).toHaveBeenCalledWith(expectedSha, bytes);
      expect(config.get(".obsidian/snippets/x.css")).toMatchObject({
        sha256: expectedSha,
        category: "snippets",
      });
    });

    it("onLocalChange: themes-disabled device ignores a theme onChange (blobPut not called, config unchanged)", async () => {
      const { ch, config, blobPut, configRead, fireOnChange } = makeChannel({
        themes: false,
        snippets: true,
      });
      const bytes = new Uint8Array([7, 8]);
      configRead.mockResolvedValue(bytes);

      ch.start();
      fireOnChange(".obsidian/themes/Foo/theme.css");

      // Wait long enough for the async chain (would include crypto.subtle.digest) to run if not skipped.
      await new Promise((r) => setTimeout(r, 80));

      expect(blobPut).not.toHaveBeenCalled();
      expect(config.get(".obsidian/themes/Foo/theme.css")).toBeUndefined();
    });

    it("bootstrap: themes-disabled device skips theme files but publishes snippets", async () => {
      const { ch, config, blobPut, configRead, configList } = makeChannel({
        themes: false,
        snippets: true,
      });
      const snippetBytes = new Uint8Array([10, 11]);
      const themeBytes = new Uint8Array([20, 21]);
      const snippetSha = await sha256OfBytes(snippetBytes);

      configList.mockResolvedValue([
        { path: ".obsidian/snippets/a.css", size: 2 },
        { path: ".obsidian/themes/b.css", size: 2 },
      ]);
      // Only the snippet read will be called (themes are skipped before reading).
      configRead.mockResolvedValueOnce(snippetBytes).mockResolvedValueOnce(themeBytes);

      await ch.bootstrap();

      expect(config.get(".obsidian/snippets/a.css")).toMatchObject({
        sha256: snippetSha,
        category: "snippets",
      });
      expect(config.get(".obsidian/themes/b.css")).toBeUndefined();
      expect(blobPut).toHaveBeenCalledTimes(1);
      expect(blobPut).toHaveBeenCalledWith(snippetSha, snippetBytes);
    });
  });
});
