import { describe, it, expect, vi } from "vitest";
import { ConfigChannel } from "./config-channel.js";
import { sha256OfBytes } from "../hash.js";
import { canonicalJsonBytes } from "./canonical.js";
import type {
  CrdtMap,
  BlobStorePort,
  ConfigPort,
  IdentityPort,
  Sha256,
  Unsubscribe,
  VaultPath,
} from "../ports.js";
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

const stubGate = (allow: (id: string) => boolean) => ({
  allows: (path: string) => {
    const m = /^\.obsidian\/plugins\/([^/]+)\//.exec(path);
    const id = m?.[1];
    return id === undefined ? true : allow(id);
  },
  platformAllowed: () => true,
});

/** In-memory blob store that actually tracks puts so get() returns stored content. */
function memBlobStore(): BlobStorePort & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    has: (sha) => Promise.resolve(blobs.has(sha)),
    put: (sha, bytes) => {
      blobs.set(sha, bytes);
      return Promise.resolve();
    },
    get: (sha) => Promise.resolve(blobs.get(sha) ?? new Uint8Array()),
  };
}

function makeChannel(
  enabledCategories: {
    themes: boolean;
    snippets: boolean;
    plugins?: boolean;
    "plugin-data"?: boolean;
  } = {
    themes: true,
    snippets: true,
  },
  gate?: { allows(path: string): boolean },
  engineState?: unknown,
  onChangeFailure?: (paths: string[]) => void,
) {
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
    now: () => 0,
    ...(gate !== undefined ? { gate } : {}),
    ...(engineState !== undefined ? { engineState: engineState as never } : {}),
    ...(onChangeFailure !== undefined ? { onChangeFailure } : {}),
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
  it("blob-store failure keeps bootstrap/publish alive, records the CRDT entry, and bounds the pass to one timeout", async () => {
    const { ch, config, blobHas, blobPut } = makeChannel();
    blobHas.mockRejectedValue(new Error("blob endpoint unavailable"));
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);

    // Config metadata remains valid offline, so a store outage must not reject engine.start().
    await expect(
      ch.publish(".obsidian/snippets/first.css" as never, first),
    ).resolves.toBeUndefined();
    await expect(
      ch.publish(".obsidian/snippets/second.css" as never, second),
    ).resolves.toBeUndefined();

    expect(config.get(".obsidian/snippets/first.css")).toBeDefined();
    expect(config.get(".obsidian/snippets/second.css")).toBeDefined();
    expect(blobHas).toHaveBeenCalledTimes(1); // one failed request, not one timeout per file
    expect(blobPut).not.toHaveBeenCalled();

    // The pending state distinguishes advertised metadata from a completed upload and heals on tick.
    blobHas.mockResolvedValue(false);
    await ch.retryPendingUploads();
    expect(blobPut).toHaveBeenCalledTimes(2);
  });

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

  it("retains a failed watcher delivery and retries it after the adapter baseline has advanced", async () => {
    const { ch, config, configRead, fireOnChange } = makeChannel();
    const bytes = new Uint8Array([9, 8, 7]);
    configRead.mockRejectedValueOnce(new Error("transient read race")).mockResolvedValue(bytes);

    const stop = ch.start();
    fireOnChange(".obsidian/snippets/retry.css"); // only one adapter notification

    await poll(() => {
      expect(config.get(".obsidian/snippets/retry.css")).toBeDefined();
    }, 1_500);
    expect(configRead).toHaveBeenCalledTimes(2);
    stop();
  });

  it("surfaces one persistent warning after bounded local-change retries are exhausted", async () => {
    const onChangeFailure = vi.fn();
    const { ch, configRead, fireOnChange } = makeChannel(
      undefined,
      undefined,
      undefined,
      onChangeFailure,
    );
    configRead.mockRejectedValue(new Error("persistent read failure"));

    const stop = ch.start();
    fireOnChange(".obsidian/snippets/stuck.css");

    await poll(() => {
      expect(onChangeFailure).toHaveBeenCalledTimes(1);
    }, 1_500);
    expect(onChangeFailure).toHaveBeenLastCalledWith([".obsidian/snippets/stuck.css"]);
    expect(configRead).toHaveBeenCalledTimes(4);
    stop();
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

  it("remote tombstone -> remove: fire deleted entry triggers configPort.remove (m6: echo.recordWrite NOT called)", async () => {
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

    // Remote tombstone path only awaits configPort.remove (Promise.resolve) — no crypto.
    // m6: echo.recordWrite is removed — it was dead (onLocalChange suppresses the remove via
    // the prev.deleted === true check, not via the echo ledger).
    await poll(() => {
      expect(configRemove).toHaveBeenCalledWith(".obsidian/snippets/x.css");
    });
    expect(echoRecordWrite).not.toHaveBeenCalled();
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

  describe("PluginGate integration", () => {
    it("publish: gate.allows() false -> blobPut not called and config entry absent", async () => {
      const { ch, config, blobPut } = makeChannel(
        { themes: true, snippets: true, plugins: true },
        stubGate(() => false),
      );
      const bytes = new Uint8Array([1, 2, 3]);
      await ch.publish(".obsidian/plugins/dv/main.js" as never, bytes);
      expect(blobPut).not.toHaveBeenCalled();
      expect(config.get(".obsidian/plugins/dv/main.js")).toBeUndefined();
    });

    it("publish: gate.allows() true -> published with category plugins", async () => {
      const { ch, config, blobPut } = makeChannel(
        { themes: true, snippets: true, plugins: true },
        stubGate(() => true),
      );
      const bytes = new Uint8Array([4, 5, 6]);
      const expectedSha = await sha256OfBytes(bytes);
      await ch.publish(".obsidian/plugins/dv/main.js" as never, bytes);
      expect(blobPut).toHaveBeenCalledWith(expectedSha, bytes);
      expect(config.get(".obsidian/plugins/dv/main.js")).toMatchObject({
        sha256: expectedSha,
        category: "plugins",
      });
    });

    it("onLocalChange: gate.allows() false -> blobPut not called", async () => {
      const { ch, blobPut, configRead, fireOnChange } = makeChannel(
        { themes: true, snippets: true, plugins: true },
        stubGate(() => false),
      );
      configRead.mockResolvedValue(new Uint8Array([7, 8]));
      ch.start();
      fireOnChange(".obsidian/plugins/dv/main.js");
      await new Promise((r) => setTimeout(r, 80));
      expect(blobPut).not.toHaveBeenCalled();
    });

    it("bootstrap: gate.allows() false -> plugin path skipped", async () => {
      const { ch, config, blobPut, configRead, configList } = makeChannel(
        { themes: true, snippets: true, plugins: true },
        stubGate(() => false),
      );
      const snippetBytes = new Uint8Array([10, 11]);
      const snippetSha = await sha256OfBytes(snippetBytes);
      configList.mockResolvedValue([
        { path: ".obsidian/snippets/a.css", size: 2 },
        { path: ".obsidian/plugins/dv/main.js", size: 3 },
      ]);
      configRead.mockResolvedValueOnce(snippetBytes);
      await ch.bootstrap();
      expect(config.get(".obsidian/snippets/a.css")).toMatchObject({ sha256: snippetSha });
      expect(config.get(".obsidian/plugins/dv/main.js")).toBeUndefined();
      expect(blobPut).toHaveBeenCalledTimes(1);
    });
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

  describe("plugin-data", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const dataPath = (id: string) =>
      `.obsidian/plugins/${id}/data.json` as Parameters<typeof ConfigChannel.prototype.publish>[0];

    /** Build a channel wired with a real in-memory blob store and configPort that can return manifest bytes. */
    function makePluginDataChannel(
      manifestBytes: Uint8Array | null,
      dataBytes: Uint8Array | null = null,
      engineState?: {
        getConfigLocalVersion(path: VaultPath): Promise<number>;
        setConfigLocalVersion(path: VaultPath, version: number): Promise<void>;
        getConfigNormalizedSha(path: VaultPath): Promise<Sha256 | null>;
        setConfigNormalizedSha(path: VaultPath, sha256: Sha256 | null): Promise<void>;
      },
    ) {
      const configMap = memMap<ConfigEntry>();
      const blobStore = memBlobStore();

      const configReadFn = vi.fn((path: string) => {
        if (path.endsWith("/manifest.json") && manifestBytes !== null) {
          return Promise.resolve(manifestBytes);
        }
        if (path.endsWith("/data.json")) return Promise.resolve(dataBytes);
        return Promise.resolve(null as Uint8Array | null);
      });
      const configPort: ConfigPort = {
        read: configReadFn,
        writeAtomic: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
        list: vi.fn(() => Promise.resolve([])),
        onChange: () => () => undefined,
        rescan: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
      };

      const identity: IdentityPort = {
        deviceId: vi.fn(() => "d" as never),
        deviceName: vi.fn(() => "dev"),
      };

      const echo = {
        recordWrite: vi.fn(() => undefined),
        isEcho: vi.fn(() => false),
        clear: vi.fn(),
      } as unknown as EchoLedger;

      const ch = new ConfigChannel({
        config: configMap,
        blobStore,
        configPort,
        identity,
        echo,
        enabledCategories: { themes: true, snippets: true, plugins: true, "plugin-data": true },
        gate: stubGate(() => true),
        ...(engineState === undefined ? {} : { engineState }),
        now: () => 0,
      });

      return { ch, configMap, blobStore };
    }

    function normalizationState() {
      return {
        getConfigLocalVersion: vi.fn(() => Promise.resolve(0)),
        setConfigLocalVersion: vi.fn(() => Promise.resolve()),
        getConfigNormalizedSha: vi.fn(() => Promise.resolve(null)),
        setConfigNormalizedSha: vi.fn(() => Promise.resolve()),
      };
    }

    it("plugin-data: publishes canonical bytes + stamps version from sibling manifest", async () => {
      const manifestBytes = enc(JSON.stringify({ version: "1.2.0" }));
      const { ch, configMap, blobStore } = makePluginDataChannel(manifestBytes);

      await ch.publish(dataPath("dv"), enc(`{"b":1,"a":2}`));

      const entry = configMap.get(dataPath("dv"));
      if (entry === undefined) throw new Error("expected plugin-data entry");
      expect(entry.category).toBe("plugin-data");
      expect(entry.version).toBe("1.2.0");

      const stored = await blobStore.get(entry.sha256);
      expect(stored).toEqual(canonicalJsonBytes(enc(`{"b":1,"a":2}`)));
    });

    it("plugin-data: cosmetic re-save does not republish (canonical churn guard)", async () => {
      const manifestBytes = enc(JSON.stringify({ version: "1.0.0" }));
      const { ch, configMap } = makePluginDataChannel(manifestBytes);

      await ch.publish(dataPath("dv"), enc(`{"a":1,"b":2}`));
      const first = configMap.get(dataPath("dv"));
      if (first === undefined) throw new Error("expected plugin-data entry");
      const sha1 = first.sha256;

      await ch.publish(dataPath("dv"), enc(`{"b":2,"a":1}`));
      const second = configMap.get(dataPath("dv"));
      if (second === undefined) throw new Error("expected plugin-data entry");
      expect(second.sha256).toBe(sha1);
    });

    it("plugin-data: suppresses a TaskNotes change limited to its device-local calendar cache", async () => {
      const path = dataPath("tasknotes");
      const remote = enc(`{"fieldMapping":{"title":"title"},"googleCalendarEventIndex":{"a":1}}`);
      const local = enc(`{"fieldMapping":{"title":"title"},"googleCalendarEventIndex":{"a":2}}`);
      const state = normalizationState();
      const { ch, configMap, blobStore } = makePluginDataChannel(null, local, state);
      const remoteSha = await sha256OfBytes(canonicalJsonBytes(remote));
      await blobStore.put(remoteSha, canonicalJsonBytes(remote));
      configMap.set(path, {
        sha256: remoteSha,
        size: remote.length,
        category: "plugin-data",
        deviceId: "peer" as never,
      });

      await ch["onLocalChange"](path);

      expect(configMap.get(path)?.sha256).toBe(remoteSha);
      expect(state.setConfigNormalizedSha).toHaveBeenCalledWith(
        path,
        await sha256OfBytes(canonicalJsonBytes(local)),
      );
    });

    it("plugin-data: applies a TaskNotes device-local toggle on disk without publishing it", async () => {
      const path = dataPath("tasknotes");
      const remote = enc(`{"fieldMapping":{"title":"title"},"enableGoogleCalendar":true}`);
      const local = enc(`{"fieldMapping":{"title":"title"},"enableGoogleCalendar":false}`);
      const state = normalizationState();
      const { ch, configMap, blobStore } = makePluginDataChannel(null, local, state);
      const remoteSha = await sha256OfBytes(canonicalJsonBytes(remote));
      await blobStore.put(remoteSha, canonicalJsonBytes(remote));
      configMap.set(path, {
        sha256: remoteSha,
        size: remote.length,
        category: "plugin-data",
        deviceId: "peer" as never,
      });

      await ch["onLocalChange"](path);

      expect(configMap.get(path)?.sha256).toBe(remoteSha);
      expect(state.setConfigNormalizedSha).toHaveBeenCalledWith(
        path,
        await sha256OfBytes(canonicalJsonBytes(local)),
      );
    });

    it("plugin-data: publishes a real TaskNotes setting change with volatile data intact", async () => {
      const path = dataPath("tasknotes");
      const remote = enc(`{"fieldMapping":{"title":"title"},"googleCalendarEventIndex":{"a":1}}`);
      const local = enc(`{"fieldMapping":{"title":"name"},"googleCalendarEventIndex":{"a":2}}`);
      const state = normalizationState();
      const { ch, configMap, blobStore } = makePluginDataChannel(null, local, state);
      const remoteSha = await sha256OfBytes(canonicalJsonBytes(remote));
      await blobStore.put(remoteSha, canonicalJsonBytes(remote));
      configMap.set(path, {
        sha256: remoteSha,
        size: remote.length,
        category: "plugin-data",
        deviceId: "peer" as never,
      });

      await ch["onLocalChange"](path);

      const published = configMap.get(path);
      if (published === undefined) throw new Error("expected published plugin data");
      expect(published.sha256).not.toBe(remoteSha);
      expect(JSON.parse(new TextDecoder().decode(await blobStore.get(published.sha256)))).toEqual({
        fieldMapping: { title: "name" },
        googleCalendarEventIndex: { a: 2 },
      });
    });

    it("plugin-data: does not treat another plugin's matching key name as volatile", async () => {
      const path = dataPath("another-search-plugin");
      const remote = enc(`{"useCache":false}`);
      const local = enc(`{"useCache":true}`);
      const state = normalizationState();
      const { ch, configMap, blobStore } = makePluginDataChannel(null, local, state);
      const remoteSha = await sha256OfBytes(canonicalJsonBytes(remote));
      await blobStore.put(remoteSha, canonicalJsonBytes(remote));
      configMap.set(path, {
        sha256: remoteSha,
        size: remote.length,
        category: "plugin-data",
        deviceId: "peer" as never,
      });

      await ch["onLocalChange"](path);

      expect(configMap.get(path)?.sha256).not.toBe(remoteSha);
    });

    it("plugin-data: no manifest -> entry published without version field", async () => {
      const { ch, configMap } = makePluginDataChannel(null);

      await ch.publish(dataPath("dv"), enc(`{"x":1}`));

      const entry = configMap.get(dataPath("dv"));
      if (entry === undefined) throw new Error("expected plugin-data entry");
      expect(entry.version).toBeUndefined();
      expect(entry.category).toBe("plugin-data");
    });

    it("non-plugin-data path: raw bytes stored, no canonicalization (themes unchanged)", async () => {
      const { ch, configMap, blobStore } = makePluginDataChannel(null);

      const rawBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await ch.publish(
        ".obsidian/themes/Foo/theme.css" as Parameters<typeof ConfigChannel.prototype.publish>[0],
        rawBytes,
      );

      const entry = configMap.get(".obsidian/themes/Foo/theme.css");
      if (entry === undefined) throw new Error("expected themes entry");
      expect(entry.category).toBe("themes");
      expect(entry.version).toBeUndefined();
      const stored = await blobStore.get(entry.sha256);
      // Raw bytes, not canonicalized
      expect(stored).toEqual(rawBytes);
    });

    it("plugin-data: a local delete does NOT tombstone (uninstall must not wipe peers)", async () => {
      const manifestBytes = enc(JSON.stringify({ version: "1.0.0" }));
      const configMap = memMap<ConfigEntry>();
      const blobStore = memBlobStore();

      let dataContent: Uint8Array | null = enc(`{"a":1}`);
      const configReadFn = vi.fn((path: string) => {
        if (path.endsWith("/manifest.json")) {
          return Promise.resolve(manifestBytes);
        }
        if (path === dataPath("dv")) return Promise.resolve(dataContent);
        return Promise.resolve(null as Uint8Array | null);
      });
      const configPort: ConfigPort = {
        read: configReadFn,
        writeAtomic: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
        list: vi.fn(() => Promise.resolve([])),
        onChange: () => () => undefined,
        rescan: vi.fn(() => Promise.resolve()),
        close: vi.fn(),
      };
      const identity: IdentityPort = {
        deviceId: vi.fn(() => "d" as never),
        deviceName: vi.fn(() => "dev"),
      };
      const echo = {
        recordWrite: vi.fn(() => undefined),
        isEcho: vi.fn(() => false),
        clear: vi.fn(),
      } as unknown as EchoLedger;

      const channel = new ConfigChannel({
        config: configMap,
        blobStore,
        configPort,
        identity,
        echo,
        enabledCategories: { themes: true, snippets: true, plugins: true, "plugin-data": true },
        gate: stubGate(() => true),
        now: () => 0,
      });

      // publish first so config has an entry
      await channel.publish(dataPath("dv"), enc(`{"a":1}`));
      expect(configMap.get(dataPath("dv"))).toBeDefined();

      // simulate the file being removed on disk
      dataContent = null;
      await channel["onLocalChange"](dataPath("dv"));

      const e = configMap.get(dataPath("dv"));
      if (e === undefined) throw new Error("expected plugin-data entry");
      expect(e.deleted).not.toBe(true); // entry preserved, no tombstone
    });

    it("themes: a local delete STILL tombstones (unchanged)", async () => {
      const { ch, config, configRead, fireOnChange } = makeChannel({
        themes: true,
        snippets: true,
      });

      const bytes = new Uint8Array([1, 2, 3]);
      configRead.mockResolvedValue(bytes);
      const themePath = ".obsidian/snippets/x.css" as Parameters<
        typeof ConfigChannel.prototype.publish
      >[0];
      await ch.publish(themePath, bytes);
      expect(config.get(themePath)).toBeDefined();

      // simulate the file being removed on disk
      configRead.mockResolvedValue(null);
      ch.start();
      fireOnChange(themePath);

      await poll(() => {
        expect(config.get(themePath)?.deleted).toBe(true);
      });
    });
  });
});

/**
 * Bootstrap must not re-read and re-hash config files that have not changed since last run.
 *
 * It used to read EVERY config-zone file on every start and hash it, only for `publish()` to
 * discover the sha was identical and return. The zone holds each synced plugin's whole bundle plus
 * theme CSS, so that is tens of megabytes of pointless IO and CPU on every launch — measured at
 * ~27s on a real Android device, and it blocks `start()`.
 *
 * The stat pair (size, mtime) is the cheap filter, persisted across restarts. Same technique as
 * git's index and rsync's quick check.
 */
describe("ConfigChannel — bootstrap stat cache", () => {
  const PATH = ".obsidian/snippets/big.css";

  function statStore(initial: Record<string, { size: number; mtime: number }>) {
    const saved: Record<string, { size: number; mtime: number }>[] = [];
    return {
      saved,
      store: {
        getConfigStats: () => Promise.resolve(initial),
        setConfigStats: (s: Record<string, { size: number; mtime: number }>) => {
          saved.push(s);
          return Promise.resolve();
        },
      },
    };
  }

  it("skips the read entirely when size and mtime match and the entry is already published", async () => {
    const { store } = statStore({ [PATH]: { size: 10, mtime: 555 } });
    const { ch, config, configList, configRead } = makeChannel(
      { themes: true, snippets: true },
      undefined,
      store,
    );
    config.set(PATH, { sha256: "abc", size: 10, category: "snippets", deviceId: "d" } as never);
    configList.mockResolvedValue([{ path: PATH, size: 10, mtime: 555 }] as never);

    await ch.bootstrap();

    expect(configRead).not.toHaveBeenCalled();
  });

  it("reads when mtime moved, even though size is the same", async () => {
    const { store } = statStore({ [PATH]: { size: 10, mtime: 555 } });
    const { ch, config, configList, configRead } = makeChannel(
      { themes: true, snippets: true },
      undefined,
      store,
    );
    config.set(PATH, { sha256: "abc", size: 10, category: "snippets", deviceId: "d" } as never);
    configList.mockResolvedValue([{ path: PATH, size: 10, mtime: 999 }] as never);
    configRead.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await ch.bootstrap();

    expect(configRead).toHaveBeenCalledWith(PATH);
  });

  it("reads on a first run, when there is no cached stat", async () => {
    const { store } = statStore({});
    const { ch, configList, configRead } = makeChannel(
      { themes: true, snippets: true },
      undefined,
      store,
    );
    configList.mockResolvedValue([{ path: PATH, size: 10, mtime: 555 }] as never);
    configRead.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await ch.bootstrap();

    expect(configRead).toHaveBeenCalledWith(PATH);
  });

  /**
   * SAFETY: the cache says "unchanged since we published it", which is only meaningful if that
   * published entry is actually in hand. If the index did not hydrate (first run against a new
   * relay, discarded snapshot), skipping would leave the file unpublished forever.
   */
  it("reads when the stat matches but the shared entry is absent", async () => {
    const { store } = statStore({ [PATH]: { size: 10, mtime: 555 } });
    const { ch, configList, configRead } = makeChannel(
      { themes: true, snippets: true },
      undefined,
      store,
    );
    configList.mockResolvedValue([{ path: PATH, size: 10, mtime: 555 }] as never);
    configRead.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await ch.bootstrap();

    expect(configRead).toHaveBeenCalledWith(PATH);
  });

  it("persists the fresh stat set so the NEXT start can skip", async () => {
    const { store, saved } = statStore({});
    const { ch, configList, configRead } = makeChannel(
      { themes: true, snippets: true },
      undefined,
      store,
    );
    configList.mockResolvedValue([{ path: PATH, size: 10, mtime: 555 }] as never);
    configRead.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await ch.bootstrap();

    expect(saved).toHaveLength(1);
    expect(saved[0]?.[PATH]).toEqual({ size: 10, mtime: 555 });
  });
});
