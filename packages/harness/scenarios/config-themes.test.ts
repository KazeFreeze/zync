/**
 * Scenario — config-themes: convergence of .obsidian/snippets and .obsidian/themes
 * files across devices via the config-sync layer.
 *
 * Config files ride the SHARED blob queue and are EXCLUDED from /fs/tree
 * (NodeFsVault excludes .obsidian/themes|snippets), so:
 *   - DO NOT use waitConverged for config assertions (tree equality won't see them).
 *   - Use waitBlobsSettled for write propagation, then device.read() for disk verification.
 *   - Use device.exists() for delete propagation (read() throws on 404; blobs.settled
 *     doesn't reflect tombstones, so poll exists() directly).
 *   - Always call configRescan() after configWrite/configRemove to force immediate
 *     detection instead of waiting on the watcher.
 *
 * Three scenarios:
 *   1. snippet propagates — write on A, confirm B materialises the bytes.
 *   2. delete propagates  — write on A, confirm B sees it, delete on A, confirm B loses it.
 *   3. self-exclusion     — zync's own plugin paths (.obsidian/zync/, .obsidian/plugins/zync/)
 *                          must never appear in configList (config tracks themes/snippets only).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { device, heal, resetStack, seedAndStart, sleep, waitBlobsSettled } from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const SNIPPET_PATH = ".obsidian/snippets/tweaks.css";
const SNIPPET_CONTENT = "/* hi */\n.x{color:red}\n";

describe("config-themes", () => {
  beforeEach(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterEach(async () => {
    await heal("device-a").catch(() => undefined);
    await heal("device-b").catch(() => undefined);
  });

  it("snippet propagates from device-a to device-b", async () => {
    await a.configWrite(SNIPPET_PATH, SNIPPET_CONTENT);
    await a.configRescan();
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    expect(await b.read(SNIPPET_PATH)).toBe(SNIPPET_CONTENT);
  }, 240_000);

  it("snippet delete propagates from device-a to device-b", async () => {
    // Phase 1: write and confirm device-b materialises the snippet.
    await a.configWrite(SNIPPET_PATH, SNIPPET_CONTENT);
    await a.configRescan();
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    expect(await b.read(SNIPPET_PATH)).toBe(SNIPPET_CONTENT);

    // Phase 2: delete on device-a and wait for the tombstone to propagate to device-b.
    // NOTE: blob settlement does NOT reflect deletions (tombstones are metadata, not blobs),
    // so we poll exists() directly rather than waitBlobsSettled.
    await a.configRemove(SNIPPET_PATH);
    await a.configRescan();

    const deadline = Date.now() + 90_000;
    for (;;) {
      if (!(await b.exists(SNIPPET_PATH))) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `config delete did not propagate to device-b within 90s — ` +
            `device-b still has ${SNIPPET_PATH} on disk`,
        );
      }
      await sleep(500);
    }

    expect(await b.exists(SNIPPET_PATH)).toBe(false);
  }, 240_000);

  it("self-exclusion: zync plugin paths are absent from configList", async () => {
    // configList must only surface themes/snippets. Zync's own plugin state
    // (.obsidian/zync/ and .obsidian/plugins/zync/) must never appear there.
    const { files } = await a.configList();
    const zyncFiles = files.filter(
      (f) => f.path.startsWith(".obsidian/zync/") || f.path.startsWith(".obsidian/plugins/zync/"),
    );
    expect(zyncFiles).toHaveLength(0);
  }, 240_000);
});
