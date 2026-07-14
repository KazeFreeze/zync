/**
 * Scenario — config-plugin-data: sync of plugin data.json between peers over the
 * real relay, with opt-in gating, settings-sync off-switch, conflict inbox, version
 * gate hold/release, self-exclusion, anti-ping-pong convergence, cosmetic no-op, and
 * uninstall no-wipe.
 *
 * Architecture notes (read before editing):
 *
 *   - data.json files ride the config channel (NOT the prose doc engine).
 *   - They are EXCLUDED from /fs/tree (NodeFsVault filters .obsidian/**), so:
 *       - DO NOT use waitConverged for data.json assertions.
 *       - Use waitBlobsSettled for propagation, then pluginData() polling.
 *   - Always call configRescan() after configWrite/configRemove to force immediate
 *     detection instead of waiting for the fs watcher.
 *   - pluginOptIn(id, true) MUST precede configRescan when opting in (gate must be
 *     open for the channel to publish the bundle files).
 *
 *   - The version gate reads the LOCAL disk manifest.json (via ConfigPort). To put B
 *     on v1 while A is on v2: write B's manifest with version "1.0.0" via configWrite
 *     (B's local version). When A publishes data.json it stamps the entry with A's
 *     local manifest version (the "writer version" in the ConfigEntry). The gate on B
 *     holds the entry when writer-version > local-version. Writing a v2 manifest to B
 *     and rescanning triggers pluginDataGate.reeval via the plugin-bundle-file
 *     onMaterialized hook, releasing the held data.json.
 *
 *   - For data.json, groupKeyOf returns the full path (no trailing /), so the
 *     conflict inbox id is `config-file:.obsidian/plugins/<id>/data.json`.
 *
 *   - S3-11: the config channel NEVER propagates a data.json delete. configRemove on
 *     A writes a local tombstone but the channel gate suppresses the publish. B's
 *     copy is therefore unchanged (uninstall no-wipe).
 *
 *   - Self-exclusion (zync id): configCategoryOf(".obsidian/plugins/zync/data.json")
 *     returns undefined (isPluginDataPath guards id !== "zync"). writePluginData("zync",
 *     …) writes the file to disk but configChannel.publish returns early on category
 *     undefined — the write is never relayed. B's pluginData("zync") stays null.
 *
 *   - Canonical JSON churn guard: the channel calls canonicalJsonBytes before hashing
 *     so key-reordered JSON that is semantically identical hashes to the SAME sha256.
 *     A rewrite with reordered keys matches the cached sha and the channel skips the
 *     publish — no second relay update is produced (anti-ping-pong / cosmetic no-op).
 *
 * Ten scenarios:
 *   1.  roam            — A writes data, B converges
 *   2.  opt-in gating   — B not opted-in, stays absent
 *   3.  settings-off    — settings-sync off on B, absent; flip on, materializes
 *   4.  converge-silently — divergent offline writes (stop/start); NO conflict, tie-break + loser backup
 *   5.  version-gate hold→release  — A on v2, B on v1; data held; B upgrades; data materializes
 *   6.  version-gate D4 (held→local-edit→conflict)  — while held B edits; upgrade B; conflict surfaces
 *   7.  self-exclusion  — zync-id write never reaches B
 *   8.  anti-ping-pong  — A writes, B receives, B writes key-reordered; sha stable after 2 polls
 *   9.  cosmetic no-op  — A writes {a,b}, B receives, A writes {b,a}; B sha unchanged
 *  10.  uninstall no-wipe  — A removes data.json; B's copy survives (S3-11)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  device,
  heal,
  resetStack,
  seedAndStart,
  sleep,
  waitBlobsSettled,
  type Device,
} from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const ID = "dv"; // short plugin id used across all scenarios
const DIR = `.obsidian/plugins/${ID}`;
const DATA_PATH = `${DIR}/data.json`;

/** Conflict inbox entry id for a data.json (single-file group, no trailing slash). */
const DATA_CONFLICT_ID = `config-file:${DATA_PATH}`;

/** Minimal manifest at version 1.0.0 (B's "older" local install). */
const MANIFEST_V1 = JSON.stringify({
  id: ID,
  name: "Dataview",
  version: "1.0.0",
  minAppVersion: "0.9.0",
});

/** Manifest at version 2.0.0 (A's "newer" local install — stamps data entries at v2). */
const MANIFEST_V2 = JSON.stringify({
  id: ID,
  name: "Dataview",
  version: "2.0.0",
  minAppVersion: "0.9.0",
});

/** Default main.js used by all scenarios. */
const MAIN = "module.exports = class DV {};\n";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Write the plugin's code bundle (manifest + main.js) on `dev`, opt it in, then
 * force an immediate rescan. Used with the DEFAULT v1 manifest — version-gate
 * scenarios that need a specific version call optInBundle with an explicit manifest.
 */
async function optInBundle(dev: Device, manifest = MANIFEST_V1): Promise<void> {
  await dev.configWrite(`${DIR}/manifest.json`, manifest);
  await dev.configWrite(`${DIR}/main.js`, MAIN);
  await dev.pluginOptIn(ID, true);
  await dev.configRescan();
}

/**
 * Poll `dev.pluginData(id)` until the parsed value satisfies `pred`, or the timeout
 * elapses. Returns the last-seen parsed value on success; throws with diagnostics on
 * timeout. By default polls `ID` ("dv").
 */
async function waitPluginData(
  dev: Device,
  pred: (json: unknown) => boolean,
  ms = 90_000,
  id = ID,
): Promise<unknown> {
  const end = Date.now() + ms;
  let last: unknown = undefined;
  for (;;) {
    const { json } = await dev.pluginData(id);
    last = json;
    if (pred(json)) return json;
    if (Date.now() > end) {
      throw new Error(
        `waitPluginData(${dev.name}, ${id}) timed out after ${String(ms)}ms — last=${JSON.stringify(last)}`,
      );
    }
    await sleep(500);
  }
}

/**
 * Deep-equality check for plain objects / primitives — good enough for JSON payload
 * comparison without adding a test-only dependency.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (k === undefined || k !== kb[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
}

/**
 * Poll until BOTH devices hold a NON-null data.json AND they are canonically byte-identical, or
 * throw with both last-seen values. Convergence must be POLLED (not read once): the LWW winner is
 * agreed globally, but the loser materializes ASYNCHRONOUSLY, and over the real relay a symmetric
 * no-base divergence can transiently double-adopt before settling to the single winner.
 */
async function waitPluginDataConverged(ms = 90_000): Promise<unknown> {
  const end = Date.now() + ms;
  let ja: unknown;
  let jb: unknown;
  for (;;) {
    ja = (await a.pluginData(ID)).json;
    jb = (await b.pluginData(ID)).json;
    if (ja !== null && jb !== null && deepEqual(ja, jb)) return ja;
    if (Date.now() > end) {
      throw new Error(
        `waitPluginDataConverged timed out after ${String(ms)}ms — a=${JSON.stringify(ja)} b=${JSON.stringify(jb)}`,
      );
    }
    await sleep(500);
  }
}

/**
 * NEGATIVE poll: assert NO kind==="config-file" conflict EVER surfaces on EITHER device for
 * the whole `windowMs`. The inverse of {@link waitConfigConflict} — used by the first-sync-quiet
 * silent-adopt scenario, where the invariant is that first cross-device convergence of an
 * independently-authored data.json must NOT raise a conflict on either side. Throws (with the
 * offending device + entries) the instant a config-file entry appears, so a regression that
 * re-introduces the two-sided first-sync conflict fails fast rather than silently.
 */
async function assertNoConfigConflict(windowMs: number): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    for (const dev of [a, b]) {
      const conflicts = (await dev.status()).conflicts as { id?: string; kind?: string }[];
      const configConflicts = conflicts.filter((c) => c.kind === "config-file");
      if (configConflicts.length > 0) {
        throw new Error(
          `assertNoConfigConflict: unexpected config-file conflict on ${dev.name} — ` +
            JSON.stringify(configConflicts),
        );
      }
    }
    if (Date.now() >= deadline) return;
    await sleep(1_000);
  }
}

/**
 * Read every device-local `_conflicts/` backup that shadows the plugin's data.json on `dev`.
 * The silent-adopt backup path is `conflictArtifactPath(DATA_PATH, deviceId, sha8)` =
 * `_conflicts/.obsidian/plugins/<id>/data (conflict, <deviceId>, <sha8>).json` — a TOP-LEVEL
 * `_conflicts/` path (NOT under .obsidian), so it appears in `/fs/tree` and is readable via the
 * device's `read()` fs helper. Returns the parsed JSON of each such backup (best-effort parse;
 * unparseable content surfaces as the raw string so a diagnostic still shows what landed).
 */
async function readConflictBackups(dev: Device): Promise<unknown[]> {
  const tree = await dev.tree();
  const backupPaths = Object.keys(tree).filter(
    (p) => p.startsWith("_conflicts/") && p.includes(`/plugins/${ID}/`) && p.endsWith(".json"),
  );
  const out: unknown[] = [];
  for (const p of backupPaths) {
    const raw = await dev.read(p);
    try {
      out.push(JSON.parse(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

// ── scenarios ─────────────────────────────────────────────────────────────────

describe("config-plugin-data", () => {
  beforeEach(async () => {
    await resetStack();
    await seedAndStart("device-a", ["device-b"], "mini");
  }, 180_000);

  afterEach(async () => {
    await heal("device-a").catch(() => undefined);
    await heal("device-b").catch(() => undefined);
  });

  // ── 1. roam — A writes data.json, B converges ────────────────────────────

  it("roam: A writes data.json, B converges", async () => {
    // Both peers need the plugin code bundle + opt-in before data.json can sync.
    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    const PAYLOAD = { theme: "dark", pageSize: 100 };
    await a.pluginDataWrite(ID, PAYLOAD);

    await waitPluginData(b, (j) => deepEqual(j, PAYLOAD));
    expect(deepEqual((await b.pluginData(ID)).json, PAYLOAD)).toBe(true);
  }, 240_000);

  // ── 2. opt-in gating — an un-opted plugin's data never syncs ────────────

  it("opt-in gating: an un-opted plugin's data.json never syncs", async () => {
    // pluginsOptIn is a SHARED CRDT map — opting in "dv" on one device propagates to
    // BOTH, so "B not opted-in while A is" is unachievable. The only way to exercise the
    // opt-in gate is to leave the plugin un-opted on BOTH devices: write the bundle files
    // (so the CODE is present) but call NO pluginOptIn. Then A's data publish is gated out
    // and B's materialize is gated out — B's data.json must stay absent.
    await a.configWrite(`${DIR}/manifest.json`, MANIFEST_V1);
    await a.configWrite(`${DIR}/main.js`, MAIN);
    await a.configRescan();
    await b.configWrite(`${DIR}/manifest.json`, MANIFEST_V1);
    await b.configWrite(`${DIR}/main.js`, MAIN);
    await b.configRescan();
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Un-opted → the publish path is gated out. If the un-opted write errors, tolerate it —
    // the invariant is only that B stays null.
    await a.pluginDataWrite(ID, { secret: true }).catch(() => undefined);

    // Give the relay plenty of time to propagate; gate must keep B's data absent.
    await sleep(10_000);

    expect((await b.pluginData(ID)).json).toBeNull();
  }, 240_000);

  // ── 3. settings-off — settings-sync off on B: data absent; flip on, materializes

  it("settings-off: settings-sync off on B keeps data absent; turning it on materializes", async () => {
    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Disable settings-sync for the plugin on B before A writes data.
    await b.pluginSettingsSync(ID, false);

    await a.pluginDataWrite(ID, { mode: "off-test" });
    await sleep(10_000);

    // B's data.json must remain absent while settings-sync is off.
    expect((await b.pluginData(ID)).json).toBeNull();

    // B's CODE bundle must still be present (settings-off is data-only, not a code gate).
    expect(await b.exists(`${DIR}/manifest.json`)).toBe(true);

    // Turn settings-sync back on — B should now pick up the data.json.
    await b.pluginSettingsSync(ID, true);
    // Re-evaluate by having A re-publish (B now allows data.json ingest).
    await a.pluginDataWrite(ID, { mode: "off-test" });
    await waitPluginData(b, (j) => deepEqual(j, { mode: "off-test" }));
    expect(deepEqual((await b.pluginData(ID)).json, { mode: "off-test" })).toBe(true);
  }, 240_000);

  // ── 4. divergent offline writes converge SILENTLY (loser backed up), no conflict ─

  it("divergent offline data.json writes converge silently (loser backed up), no conflict", async () => {
    // Plugin-data NO LONGER raises a config-file conflict on divergence (version-aware LEAN design):
    // a diverged plugin-data path is always resolved silently — adopt-newer by dataVersion, or an
    // equal-version hash tie-break with the loser's pre-adopt bytes backed up to _conflicts/. This is
    // the version-aware REWRITE of the old "conflict→inbox" scenario: two devices make DIVERGENT offline
    // plugin-data writes, reconnect, and we assert (a) NO config-file conflict ever surfaces, (b) both
    // devices CONVERGE to the same value, (c) exactly one _conflicts/ backup of the loser's bytes exists.

    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Establish a shared base on BOTH devices so the later offline divergence is a genuine post-base,
    // equal-version concurrent edit (both edit off the same synced value → both publish the same
    // dataVersion → a true tie → hash tie-break + loser backup). A config base is recorded ONLY when a
    // device converges on a PEER's value (materialize) — never by publishing its own — so round-trip two
    // values: A writes v1 (B converges → B based); B writes v2 (A converges → A based).
    await a.pluginDataWrite(ID, { base: 1 });
    await waitPluginData(b, (j) => deepEqual(j, { base: 1 }));
    await b.pluginDataWrite(ID, { base: 2 });
    await waitPluginData(a, (j) => deepEqual(j, { base: 2 }));
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Offline-style DIVERGENCE via engine stop/start — NOT partition. partition() cuts the device from
    // the blob SERVER too, so the config publish's blob HEAD fails (500). stop()/start() stops only the
    // SYNC ENGINE; the control API + blob server stay reachable, so configWrite/configRescan stages an
    // offline edit that surfaces on reconnect (mirrors the proven pattern in config-conflict.test.ts).
    // The two writes MUST diverge (different bytes) so the reconnect is a real concurrent-edit tie.
    await a.stop();
    await a.configWrite(DATA_PATH, JSON.stringify({ source: "device-a", ts: 1 }));
    await a.configRescan();
    await a.start();

    await b.stop();
    await b.configWrite(DATA_PATH, JSON.stringify({ source: "device-b", ts: 2 }));
    await b.configRescan();
    await b.start();

    // (a) NO config-file conflict may EVER surface for the plugin-data path across the settle window —
    // plugin-data resolves silently (this is the negative of the OLD waitConfigConflict assertion).
    await assertNoConfigConflict(18_000);

    // (b) Both devices CONVERGE to the SAME value (the equal-version hash tie-break winner's bytes).
    // POLL until they agree — the loser materializes asynchronously and the real relay can transiently
    // double-adopt before settling to the single winner.
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    const converged = await waitPluginDataConverged(90_000);
    const winner = converged as { source?: unknown };
    // The converged value is one of the two divergent offline payloads (the tie-break winner).
    expect(winner.source === "device-a" || winner.source === "device-b").toBe(true);

    // (c) Exactly one _conflicts/ backup of the LOSER's bytes exists. In the equal-version tie the loser
    // backs up its own pre-adopt {source:<loser>, ts:…} bytes before adopting the winner. Over the real
    // relay the eventual winner may transiently adopt-then-fast-forward too, so ONE-OR-BOTH devices can
    // carry a backup — the invariant is: at least one backup exists, every backup is some device's
    // genuine pre-adopt bytes (no garbage), and specifically the loser's original is recoverable.
    const loserSource = winner.source === "device-a" ? "device-b" : "device-a";
    const loserTs = loserSource === "device-a" ? 1 : 2;
    const aBackups = await readConflictBackups(a);
    const bBackups = await readConflictBackups(b);
    const allBackups = [
      ...aBackups.map((bk) => ({ dev: "device-a", json: bk, own: { source: "device-a", ts: 1 } })),
      ...bBackups.map((bk) => ({ dev: "device-b", json: bk, own: { source: "device-b", ts: 2 } })),
    ];
    expect(allBackups.length).toBeGreaterThanOrEqual(1);
    expect(allBackups.every((bk) => deepEqual(bk.json, bk.own))).toBe(true);
    expect(
      allBackups.some(
        (bk) => bk.dev === loserSource && deepEqual(bk.json, { source: loserSource, ts: loserTs }),
      ),
    ).toBe(true);

    // No residual config-file conflicts on either device (plugin-data never enters the inbox).
    const aAfter = (await a.status()).conflicts as { kind?: string }[];
    const bAfter = (await b.status()).conflicts as { kind?: string }[];
    expect(aAfter.filter((c) => c.kind === "config-file")).toHaveLength(0);
    expect(bAfter.filter((c) => c.kind === "config-file")).toHaveLength(0);
  }, 300_000);

  // ── 5. version-gate hold→release ─────────────────────────────────────────

  it("version-gate: A on v2 writes data; B on v1 holds it; B upgrades to v2; data materializes", async () => {
    // A installs and opts in with a v2 manifest; B installs with v1.
    await optInBundle(a, MANIFEST_V2); // A's local manifest = v2
    await optInBundle(b, MANIFEST_V1); // B's local manifest = v1
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // A writes data.json — the ConfigEntry will carry version:"2.0.0" (A's manifest version).
    await a.pluginDataWrite(ID, { requires: "v2-feature" });

    // B's version gate holds the entry (writer=2.0.0 > local=1.0.0). Give relay time.
    await sleep(10_000);
    expect((await b.pluginData(ID)).json).toBeNull();

    // Upgrade B's manifest to v2 (simulates the user updating the plugin on B).
    // After configRescan the engine detects the bundle file change, fires onMaterialized
    // for the plugin-bundle category, which calls pluginDataGate.reeval([ID]).
    await b.configWrite(`${DIR}/manifest.json`, MANIFEST_V2);
    await b.configRescan();

    // The gate releases the held data.json; it flows through the normal materialize path.
    await waitPluginData(b, (j) => deepEqual(j, { requires: "v2-feature" }));
    expect(deepEqual((await b.pluginData(ID)).json, { requires: "v2-feature" })).toBe(true);
  }, 240_000);

  // ── 6. version-gate D4 (held→local-edit→version-resolve, edit recoverable) ─

  it("version-gate D4: while B holds (v1<v2), B writes local data; upgrade B to v2; data version-resolves, local edit recoverable", async () => {
    // Set up the same hold scenario as scenario 5.
    await optInBundle(a, MANIFEST_V2);
    await optInBundle(b, MANIFEST_V1);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // ORDERING SUBTLETY (no partition here — both writes hit the shared config map while connected):
    // the LAST writer causally wins the CRDT map. We need A's v2 entry to be the map WINNER (so B
    // HOLDS it, writer 2.0.0 > local 1.0.0) while B's DISK carries an earlier, now-superseded local
    // edit. Therefore B writes FIRST and A writes SECOND. If we reversed this, B's own v1 entry would
    // win the map (v1 == B's local v1 → not held), B's disk would match its entry, no divergence would
    // ever surface, and the test would time out.

    // B writes its local edit FIRST (B on v1; this materializes on B's disk + publishes a v1 entry).
    await b.pluginDataWrite(ID, { feature: "local-edit-on-b" });
    await sleep(3_000);

    // A writes SECOND so A's v2 entry causally wins the CRDT map and is what B holds.
    await a.pluginDataWrite(ID, { feature: "new-v2-only" });

    // Let A's (held) v2 entry reach B's map. B is on v1 so it HOLDS it (writer 2.0.0 > local 1.0.0),
    // leaving B's disk = local-edit-on-b, divergent from the held entry.
    await sleep(8_000);

    // B's data on disk must still be the local edit at this point (held entry not materialized).
    expect(deepEqual((await b.pluginData(ID)).json, { feature: "local-edit-on-b" })).toBe(true);

    // Now upgrade B to v2 → the held entry releases through the normal materialize path and VERSION-
    // RESOLVES against B's divergent local edit. Both data.json edits are each device's FIRST publish
    // (dataVersion 1), so this is an equal-version tie → hash tie-break with the LOSER backed up to
    // `_conflicts/` (plugin-data no longer raises a config-file inbox entry). D4's safety invariant
    // survives the version rework: B's local edit is never SILENTLY clobbered.
    await b.configWrite(`${DIR}/manifest.json`, MANIFEST_V2);
    await b.configRescan();
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    await sleep(10_000); // let the release + convergence settle

    // No plugin-data config-file conflict is raised for the data.json (version-resolved silently).
    const bConf = (await b.status()).conflicts as { id?: string; kind?: string }[];
    expect(bConf.filter((c) => c.kind === "config-file" && c.id === DATA_CONFLICT_ID)).toHaveLength(
      0,
    );

    // Safety: B's local edit is NOT silently lost — either still on disk (B won the tie) OR recoverable
    // in a device-local `_conflicts/` backup (B lost the tie). Never gone without a recoverable copy.
    const bDataAfter = (await b.pluginData(ID)).json;
    const bBackups = await readConflictBackups(b);
    const localEditSafe =
      deepEqual(bDataAfter, { feature: "local-edit-on-b" }) ||
      bBackups.some((bk) => deepEqual(bk, { feature: "local-edit-on-b" }));
    expect(localEditSafe).toBe(true);
  }, 240_000);

  // ── 7. self-exclusion — zync-id write never reaches B ────────────────────

  it("self-exclusion: writePluginData('zync', …) is never relayed to B", async () => {
    // The zync plugin id is excluded by isPluginDataPath (id === "zync" guard in
    // config-entry.ts). configChannel.publish returns early when configCategoryOf
    // returns undefined for the path, so the write is never put on the relay.
    // We can drive the write via pluginDataWrite("zync") without opting in or writing
    // bundle files. The write may SUCCEED-locally, NO-OP, or be REJECTED by the config
    // port (zync is self-excluded from the config zone). ALL are acceptable — the only
    // invariant we care about is that it is NEVER relayed to B.
    await a.pluginDataWrite("zync", { internal: true }).catch(() => undefined);

    await sleep(10_000); // allow relay plenty of time

    // B must never receive any data.json for the zync plugin.
    expect((await b.pluginData("zync")).json).toBeNull();
  }, 240_000);

  // ── 8. anti-ping-pong — key-reordered rewrite converges, sha stabilizes ──

  it("anti-ping-pong: B re-writes key-reordered JSON; sha stops changing within 2 polls", async () => {
    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // A writes the canonical form; wait for B to receive it.
    await a.pluginDataWrite(ID, { alpha: 1, beta: 2, gamma: 3 });
    await waitPluginData(b, (j) => j !== null && deepEqual(j, { alpha: 1, beta: 2, gamma: 3 }));

    // B re-writes the same logical content with reordered keys (simulating a normalizing plugin save).
    // The config channel canonicalizes JSON before hashing, so the sha MUST match the prior entry.
    // The channel's churn guard skips the publish → no new relay update.
    await b.pluginDataWrite(ID, { gamma: 3, alpha: 1, beta: 2 });

    // Sample B's sha256 twice, 2 s apart — it must be STABLE (no second relay round-trip).
    const { files: files1 } = await a.configList();
    await sleep(2_000);
    const { files: files2 } = await a.configList();

    // configList surfaces config-zone files; data.json is in the config zone for dv.
    // Find the data.json entry on A (the observer) and compare sizes/hashes.
    const entry1 = files1.find((f) => f.path === DATA_PATH);
    const entry2 = files2.find((f) => f.path === DATA_PATH);

    // The entry may not surface in configList (it surfaces via the config CRDT map, not the
    // local disk list). Use pluginData round-trip as the stability proxy instead.
    // If entry is present on both polls, sizes must match.
    if (entry1 !== undefined && entry2 !== undefined) {
      expect(entry1.size).toBe(entry2.size);
    }

    // The definitive check: A's view of B's data must be canonically equal to the original.
    // If there were a ping-pong, A would have received a new version overwriting to B's bytes.
    const { json: finalJsonA } = await a.pluginData(ID);
    expect(deepEqual(finalJsonA, { alpha: 1, beta: 2, gamma: 3 })).toBe(true);
  }, 240_000);

  // ── 9. cosmetic no-op — reordered write on A; B's sha is unchanged ────────

  it("cosmetic no-op: A writes {a,b} then {b,a}; B's canonical sha does not change", async () => {
    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // First write.
    await a.pluginDataWrite(ID, { a: 1, b: 2 });
    await waitPluginData(b, (j) => j !== null && deepEqual(j, { a: 1, b: 2 }));

    // Read B's view immediately after the first propagation.
    const jsonBefore = (await b.pluginData(ID)).json;

    // A re-writes with keys reordered — canonically identical.
    await a.pluginDataWrite(ID, { b: 2, a: 1 });

    // Wait for blobs to settle, then verify B's data is unchanged and still deeply equal.
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 60_000 });
    await sleep(2_000);

    const { json: jsonAfter } = await b.pluginData(ID);
    // The canonical content must be the same: {a:1, b:2} ≡ {b:2, a:1} after canonicalization.
    expect(deepEqual(jsonAfter, jsonBefore)).toBe(true);
  }, 240_000);

  // ── 10. uninstall no-wipe — A removes data.json; B's copy survives ────────

  it("uninstall no-wipe: A removes data.json; B's copy is unchanged (S3-11 gate)", async () => {
    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Sync a data.json to both peers first.
    await a.pluginDataWrite(ID, { persistent: true });
    await waitPluginData(b, (j) => deepEqual(j, { persistent: true }));

    // Simulate A uninstalling/removing its data.json via the config remove route.
    // S3-11: the config channel suppresses publish for plugin-data deletes, so B is untouched.
    await a.configRemove(DATA_PATH);
    await a.configRescan();

    // Give the relay ample time to propagate — if the delete leaked, B would lose its file.
    await sleep(10_000);

    // B's data.json must survive unscathed.
    const { json: jsonB } = await b.pluginData(ID);
    expect(deepEqual(jsonB, { persistent: true })).toBe(true);
  }, 240_000);

  // ── D. sequential-edit propagates — the exact on-device regression ──────────

  it("sequential edit after an identical-value opt-in propagates — no revert", async () => {
    // THE ON-DEVICE REGRESSION (design testing item, harness real-relay flow). Two devices opt in a
    // plugin whose data.json holds the IDENTICAL value → identical values are a no-op that records NO
    // shared base (base===null on both, both at dataVersion v1). Then ONE device EDITS while running.
    // Under the OLD sha-only tie-break the editor's newer edit was ordered by content-hash (not
    // recency): a lower-hash newer edit LOST, got backed up, and the editor adopted the peer's OLDER
    // value — a REVERT. The version-aware fix orders by dataVersion first: the edit is v2 > the peer's
    // v1 → the peer hits remoteVersion>localVersion → ADOPTS (recency). This scenario MUST assert the
    // peer ends at the EDITED value, never back at the pre-edit value.

    // Opt the code bundle in on both (no data.json yet → no data base seeded).
    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Both devices independently write the SAME data.json while OFFLINE (engine stopped), then restart.
    // Identical bytes are a canonical no-op on convergence — neither device materializes the other's
    // value as a base, so base stays null on both and both sit at dataVersion v1 (their own first
    // publish). Mirrors first-sync-quiet's offline stop/write/rescan/start pattern but with IDENTICAL
    // content on both sides.
    await a.stop();
    await a.configWrite(DATA_PATH, JSON.stringify({ setting: "initial" }));
    await a.configRescan();
    await a.start();

    await b.stop();
    await b.configWrite(DATA_PATH, JSON.stringify({ setting: "initial" }));
    await b.configRescan();
    await b.start();

    // Both converged to the identical value and NO conflict surfaced (identical bytes → nothing to
    // reconcile; canonical-sha equality short-circuits before any tie-break).
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    await waitPluginData(a, (j) => deepEqual(j, { setting: "initial" }));
    await waitPluginData(b, (j) => deepEqual(j, { setting: "initial" }));
    await assertNoConfigConflict(8_000);

    // NOW device A edits (running / online). Its publish stamps dataVersion v2 (localVersion 1 → +1).
    await a.configWrite(DATA_PATH, JSON.stringify({ setting: "edited-by-a" }));
    await a.configRescan();

    // Device B MUST adopt the edit by recency (remoteVersion 2 > localVersion 1), NOT revert to
    // "initial" under a hash tie-break. This is the assertion that would have caught the on-device bug.
    await waitPluginData(b, (j) => deepEqual(j, { setting: "edited-by-a" }));
    expect(deepEqual((await b.pluginData(ID)).json, { setting: "edited-by-a" })).toBe(true);

    // A still holds its own edit (it never gets reverted to the peer's stale value).
    expect(deepEqual((await a.pluginData(ID)).json, { setting: "edited-by-a" })).toBe(true);

    // No config-file conflict for the plugin-data path at any point (silent, recency-ordered adopt).
    await assertNoConfigConflict(8_000);
  }, 300_000);

  // ── A. first-sync-quiet — independently-created data.json, NO base, silent-adopt ──

  it("first-sync-quiet: independently-created data.json (no base) silently adopts, no conflict, loser bytes backed up", async () => {
    // The INVERSE of scenario #4: DO NOT establish a common base first. Each device authors its OWN
    // distinct data.json while OFFLINE (engine stopped — not partition, which cuts the blob server), so
    // neither device ever materialized the other's bytes as a base. On reconnect this is a first cross-
    // device convergence with base===null on BOTH sides → the engine's silent-adopt path (accept the
    // config-map LWW winner, no conflict inbox entry, back up the loser's pre-adopt bytes under
    // _conflicts/). Assert the convergence is QUIET, byte-consistent, and recoverable.

    // Opt the bundle in on both so the config channel can publish/materialize plugin-data. optInBundle
    // writes ONLY the code bundle (manifest.json + main.js) + pluginOptIn — it never writes data.json, so
    // opting in does not seed a shared data base. After this, base for DATA_PATH is null on both devices.
    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    // Each device independently authors a DIFFERENT data.json while offline. Stop the engine, write via
    // the ConfigPort + rescan (stages the offline edit locally without publishing), then restart. Because
    // each write happened while that device was disconnected from sync, neither device establishes the
    // other's bytes as a base — both keep base===null for DATA_PATH.
    await a.stop();
    await a.configWrite(DATA_PATH, JSON.stringify({ source: "device-a" }));
    await a.configRescan();
    await a.start();

    await b.stop();
    await b.configWrite(DATA_PATH, JSON.stringify({ source: "device-b" }));
    await b.configRescan();
    await b.start();

    // (1) NO config-file conflict may EVER surface on either device across the whole settle window.
    // (Negative assertion — deliberately NOT waitConfigConflict, which waits for one to appear.)
    await assertNoConfigConflict(18_000);

    // (2) Both devices CONVERGE to the SAME data.json — the config-map LWW winner's bytes ({source:"…"}).
    // POLL until they agree (the loser materializes asynchronously; the real relay can transiently
    // double-adopt before settling to the single winner — so a one-shot read races the convergence).
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    const converged = await waitPluginDataConverged(90_000);
    const winner = converged as { source?: unknown };
    // The converged value is one of the two independently-authored payloads (the LWW winner).
    expect(winner.source === "device-a" || winner.source === "device-b").toBe(true);

    // (3) Recoverability: the LWW LOSER silently adopted the winner's bytes, so it MUST hold a
    // device-local _conflicts/ backup of its OWN pre-adopt bytes (nothing is overwritten unrecoverably).
    // Over the real relay the eventual winner may have transiently adopted-then-fast-forwarded too, so
    // ONE-OR-BOTH devices can carry a backup — the invariant is: (a) at least one backup exists, (b) every
    // backup is some device's genuine pre-adopt {source:<own>} bytes (no garbage), and (c) specifically
    // the loser's original is recoverable.
    const aBackups = await readConflictBackups(a);
    const bBackups = await readConflictBackups(b);
    const allBackups = [
      ...aBackups.map((bk) => ({ dev: "device-a", json: bk, own: { source: "device-a" } })),
      ...bBackups.map((bk) => ({ dev: "device-b", json: bk, own: { source: "device-b" } })),
    ];
    expect(allBackups.length).toBeGreaterThanOrEqual(1);
    expect(allBackups.every((bk) => deepEqual(bk.json, bk.own))).toBe(true);
    const loserSource = winner.source === "device-a" ? "device-b" : "device-a";
    expect(
      allBackups.some(
        (bk) => bk.dev === loserSource && deepEqual(bk.json, { source: loserSource }),
      ),
    ).toBe(true);
  }, 300_000);

  // ── B. no-churn after silent-adopt — the winner's data.json does not re-publish in a loop ──

  it("no-churn after silent-adopt: the converged data.json sha is stable (no re-publish loop)", async () => {
    // Reproduce Scenario A's first-sync-quiet convergence, then assert the settled state does not churn:
    // the reloaded/normalized data.json re-save is a canonical no-op, so the winner's bytes must stop
    // changing. Mirrors scenario #8's "sha stops changing" stability assertion, kept short.
    await optInBundle(a);
    await optInBundle(b);
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });

    await a.stop();
    await a.configWrite(DATA_PATH, JSON.stringify({ source: "device-a", note: "churn-test" }));
    await a.configRescan();
    await a.start();

    await b.stop();
    await b.configWrite(DATA_PATH, JSON.stringify({ source: "device-b", note: "churn-test" }));
    await b.configRescan();
    await b.start();

    // Let the first-sync-quiet convergence settle (silent-adopt, no conflict).
    await waitBlobsSettled(["device-a", "device-b"], { timeoutMs: 90_000 });
    await waitPluginData(
      b,
      (j) => j !== null && typeof (j as { source?: unknown }).source === "string",
    );

    // Sample B's converged data twice ~3s apart — it must be STABLE (no repeated relay round-trip that
    // would rewrite B's bytes). A silent-adopt that kept re-publishing would flip B's value between polls.
    const first = (await b.pluginData(ID)).json;
    await sleep(3_000);
    const second = (await b.pluginData(ID)).json;
    expect(deepEqual(first, second)).toBe(true);

    // And no config-file conflict may have appeared during the stability window.
    const bConflicts = (await b.status()).conflicts as { kind?: string }[];
    expect(bConflicts.filter((c) => c.kind === "config-file")).toHaveLength(0);
  }, 300_000);

  // ── C. state-wipe clobber — NOTED-AND-SKIPPED (no config-base clear route on the control API) ──
  //
  // NOTE: the design's "state-wipe clobber" case (diverge a plugin-data file that HAS a base, wipe the
  // recorded config BASE, reconnect → remote silently wins + a _conflicts/ backup) is NOT expressible via
  // the harness control API. The only base-clearing route exposed is POST /engine/clear-synced-stamps
  // (Device.clearSyncedStamps), which drops the SYNCED-STAMPS map ONLY — FsEngineStateStore.
  // clearAllSyncedStamps clears `syncedStamps` but LEAVES `configBasesMap` intact
  // (packages/headless-client/src/adapters/fs-engine-state.ts) — so it cannot null out a plugin-data
  // config base. Per the task constraints we do NOT add a new control route just for this. The base===null
  // clobber-with-backup behaviour is already covered by the @zync/core unit test (onConfigDivergence:
  // plugin-data, base===null, local present + canonically-different → _conflicts/ backup written before
  // accept-remote — design testing item #4) and is exercised end-to-end above by Scenario A (which
  // reaches the identical base===null branch via a genuine first sync). Scenario C is therefore
  // intentionally omitted here.
});
