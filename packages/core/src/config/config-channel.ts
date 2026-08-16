import type {
  BlobStorePort,
  ConfigStat,
  CrdtMap,
  ConfigPort,
  IdentityPort,
  Sha256,
  Unsubscribe,
  VaultPath,
} from "../ports.js";
import type { EchoLedger } from "../bridge/echo.js";
import { sha256OfBytes } from "../hash.js";
import { canonicalJsonBytes, configIdentitySha } from "./canonical.js";
import { configCategoryOf, pluginIdOf, type ConfigEntry } from "./config-entry.js";
import {
  classifyPluginDataChange,
  tryParseJson,
  NOISY_DATA_KEYS,
  type EchoDecision,
} from "./plugin-data-classify.js";
import { ConfigLoopBreaker } from "./loop-breaker.js";

export interface ConfigChannelDeps {
  config: CrdtMap<ConfigEntry>;
  blobStore: BlobStorePort;
  configPort: ConfigPort;
  identity: IdentityPort;
  echo: EchoLedger;
  /**
   * plugin-data version-aware convergence: the per-path edit-version counter. Optional so simpler
   * tests can omit it (a versionless publish is treated as version 0 by the divergence tie-break).
   * Production always wires the engine-state store.
   */
  engineState?: {
    getConfigLocalVersion(path: VaultPath): Promise<number>;
    setConfigLocalVersion(path: VaultPath, version: number): Promise<void>;
    getConfigNormalizedSha(path: VaultPath): Promise<Sha256 | null>;
    setConfigNormalizedSha(path: VaultPath, sha256: Sha256 | null): Promise<void>;
    /** Bootstrap's stat cache. Optional on the port, so optional here — absent ⇒ nothing skipped. */
    getConfigStats?(): Promise<Record<string, ConfigStat>>;
    setConfigStats?(stats: Record<string, ConfigStat>): Promise<void>;
  };
  /** Which config categories this device syncs. Absent category = not published or materialized. */
  enabledCategories: {
    themes: boolean;
    snippets: boolean;
    plugins?: boolean;
    "plugin-data"?: boolean;
  };
  /** Optional gate consulted for every config path; transparent for non-plugin paths. */
  gate?: { allows(path: VaultPath): boolean };
  /** Called (once) when the loop-breaker trips for a config path — a runaway republish loop. */
  onLoopDetected?(path: VaultPath): void;
  /** Surface config changes that remain undelivered after the bounded retry pass. */
  onChangeFailure?(paths: VaultPath[]): void;
  /** Monotonic clock for the loop-breaker. */
  now(): number;
}

/**
 * Config-zone (themes/snippets) sync coordinator. Detection + IO happen through the ConfigPort
 * (the prose VaultPort is blind to `.obsidian/**`). Local changes -> publish; local deletes ->
 * tombstone; remote tombstones -> remove the local file. Live remote content is materialized by the
 * shared BlobEngine (via RoutedManifest + RoutedVault), not here.
 */
export class ConfigChannel {
  private readonly loopBreaker = new ConfigLoopBreaker({ now: () => this.d.now() });
  /** One failed store request blocks the rest of this pass, preventing one timeout per config file. */
  private localUploadBlocked = false;
  /** Failed uploads retain their exact content because the config CRDT entry is still valid offline. */
  private readonly pendingUploads = new Map<VaultPath, { sha256: Sha256; bytes: Uint8Array }>();

  private static readonly MAX_PENDING_UPLOADS = 1_024;
  private static readonly MAX_PENDING_CHANGES = 1_024;
  private static readonly MAX_CHANGE_ATTEMPTS = 4;
  private readonly pendingLocalChanges = new Map<VaultPath, number>();
  private readonly failedLocalChanges = new Set<VaultPath>();
  private readonly pendingRemoteChanges: string[][] = [];
  private changeDrainRunning = false;
  private changeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly d: ConfigChannelDeps) {}

  /** Returns true when this device syncs files in the given path's category. */
  private categoryEnabled(path: VaultPath): boolean {
    const c = configCategoryOf(path);
    return c !== undefined && this.d.enabledCategories[c] === true;
  }

  /** Returns true when no gate is configured OR the gate allows this path. */
  private gateAllows(path: VaultPath): boolean {
    return this.d.gate === undefined || this.d.gate.allows(path);
  }

  /** Read a plugin's local manifest.json version via the config port; undefined if absent/unparseable. */
  private async manifestVersion(id: string): Promise<string | undefined> {
    const bytes = await this.d.configPort.read(
      `.obsidian/plugins/${id}/manifest.json` as VaultPath,
    );
    if (bytes === null) return undefined;
    try {
      return (JSON.parse(new TextDecoder().decode(bytes)) as { version?: string }).version;
    } catch {
      return undefined;
    }
  }

  /** Content-address, store once, publish a ConfigEntry (idempotent on identical content). */
  async publish(path: VaultPath, bytes: Uint8Array): Promise<void> {
    if (!this.categoryEnabled(path)) return;
    if (!this.gateAllows(path)) return;
    const category = configCategoryOf(path);
    if (category === undefined) return;
    if (!this.loopBreaker.allow(path)) return; // circuit-breaker tripped — suppress to stop a runaway loop
    const isData = category === "plugin-data";
    const content = isData ? canonicalJsonBytes(bytes) : bytes;
    const sha256 = await sha256OfBytes(content);
    const cur = this.d.config.get(path);
    if (cur !== undefined && cur.deleted !== true && cur.sha256 === sha256) return; // canonical churn guard
    let uploaded = false;
    if (!this.localUploadBlocked) {
      try {
        if (!(await this.d.blobStore.has(sha256))) await this.d.blobStore.put(sha256, content);
        uploaded = true;
      } catch {
        // The config map is valid offline, but propagating this failure aborts engine.start() and
        // leaves all note sync behind engineReady forever. Latch the pass so a large config tree
        // pays at most one store timeout, and retain the bytes for the shared retry tick.
        this.localUploadBlocked = true;
      }
    }
    if (uploaded) this.pendingUploads.delete(path);
    else this.rememberPendingUpload(path, sha256, content);
    const id = isData ? pluginIdOf(path) : undefined;
    const version = id !== undefined ? await this.manifestVersion(id) : undefined;
    // plugin-data version-aware convergence: a plain publish is a NEW local edit, so bump the per-path
    // edit-version (recency). Persist it so a later divergence orders this value against a peer's by
    // version, not just content-hash. NOT setConfigBase here — a plain publish must route a concurrent
    // equal-version peer edit to the divergence tie-break, not the clean fast-forward.
    let newDataVersion: number | undefined;
    if (isData && this.d.engineState !== undefined) {
      newDataVersion = (await this.d.engineState.getConfigLocalVersion(path)) + 1;
    }
    // Persist the plugin-data version before publishing the CRDT entry. If this durable write
    // fails, the serialized watcher queue retries the whole path; setting the map first would make
    // the retry hit the identical-sha churn guard and silently consume the failed engine-state write.
    if (isData && newDataVersion !== undefined && this.d.engineState !== undefined) {
      await this.d.engineState.setConfigLocalVersion(path, newDataVersion);
    }
    this.d.config.set(path, {
      sha256,
      size: content.length,
      category,
      deviceId: this.d.identity.deviceId(),
      ...(version !== undefined ? { version } : {}),
      ...(newDataVersion !== undefined ? { dataVersion: newDataVersion } : {}),
    });
    if (this.loopBreaker.record(path)) this.d.onLoopDetected?.(path);
  }

  /** Retry failed config uploads on the blob engine's existing retry/connectivity tick. */
  async retryPendingUploads(): Promise<void> {
    this.localUploadBlocked = false; // one bounded store attempt per retry batch
    for (const [path, pending] of [...this.pendingUploads]) {
      try {
        if (!(await this.d.blobStore.has(pending.sha256))) {
          await this.d.blobStore.put(pending.sha256, pending.bytes);
        }
        const current = this.d.config.get(path);
        if (current?.deleted !== true && current?.sha256 === pending.sha256) {
          this.pendingUploads.delete(path);
        } else {
          this.pendingUploads.delete(path); // the CRDT entry moved; these bytes are no longer owed
        }
      } catch {
        this.localUploadBlocked = true;
        break;
      }
    }
  }

  private rememberPendingUpload(path: VaultPath, sha256: Sha256, bytes: Uint8Array): void {
    this.pendingUploads.delete(path); // refresh insertion order for the newest generation
    this.pendingUploads.set(path, { sha256, bytes });
    if (this.pendingUploads.size <= ConfigChannel.MAX_PENDING_UPLOADS) return;
    const oldest = this.pendingUploads.keys().next().value;
    if (oldest !== undefined) this.pendingUploads.delete(oldest);
    // Bounded memory is preferable to retaining an unbounded plugin tree, but eviction must be
    // visible because that path now needs a later disk rescan to upload its bytes.
    this.d.onChangeFailure?.([...(oldest === undefined ? [] : [oldest])]);
  }

  /** Subscribe to local config-file changes AND remote config-map tombstones. */
  start(): Unsubscribe {
    this.stopped = false;
    const u1 = this.d.configPort.onChange((path) => {
      this.enqueueLocalChange(path);
    });
    const u2 = this.d.config.observe((keys) => {
      this.pendingRemoteChanges.push(keys);
      this.scheduleChangeDrain();
    });
    this.scheduleChangeDrain(); // resume retained failures if the same engine instance restarts
    return () => {
      this.stopped = true;
      if (this.changeRetryTimer !== null) clearTimeout(this.changeRetryTimer);
      this.changeRetryTimer = null;
      u1();
      u2();
    };
  }

  /** Re-arm exhausted local-change work on a connectivity/heal tick. */
  retryPendingChanges(): void {
    for (const path of this.pendingLocalChanges.keys()) this.pendingLocalChanges.set(path, 0);
    this.scheduleChangeDrain();
  }

  private enqueueLocalChange(path: VaultPath): void {
    if (!this.pendingLocalChanges.has(path)) {
      if (this.pendingLocalChanges.size >= ConfigChannel.MAX_PENDING_CHANGES) {
        // The queue must remain bounded under watcher storms; make the undelivered newest path
        // persistently visible instead of silently growing memory or pretending it was handled.
        this.failedLocalChanges.add(path);
        this.d.onChangeFailure?.([...this.failedLocalChanges]);
        return;
      }
      this.pendingLocalChanges.set(path, 0);
    }
    this.scheduleChangeDrain();
  }

  private scheduleChangeDrain(delayMs = 0): void {
    if (this.stopped) return;
    if (delayMs > 0) {
      if (this.changeRetryTimer !== null) return;
      this.changeRetryTimer = setTimeout(() => {
        this.changeRetryTimer = null;
        this.scheduleChangeDrain();
      }, delayMs);
      return;
    }
    if (this.changeDrainRunning) return;
    void this.drainChanges().then(
      () => undefined,
      () => undefined,
    );
  }

  private async drainChanges(): Promise<void> {
    if (this.changeDrainRunning || this.stopped) return;
    this.changeDrainRunning = true;
    try {
      // Remote removes and local reads/publishes share one executor so callbacks cannot race each
      // other through echo/base state. Each local path gets one attempt per pass; failures stay
      // queued because both filesystem adapters have already advanced their stat baselines.
      while (this.pendingRemoteChanges.length > 0) {
        const keys = this.pendingRemoteChanges.shift();
        if (keys !== undefined) await this.onRemoteChange(keys);
      }
      let needsRetry = false;
      for (const [path, attempts] of [...this.pendingLocalChanges]) {
        if (attempts >= ConfigChannel.MAX_CHANGE_ATTEMPTS) continue;
        try {
          await this.onLocalChange(path);
          this.pendingLocalChanges.delete(path); // delivery, not observation, consumes the change
          if (this.failedLocalChanges.delete(path)) {
            this.d.onChangeFailure?.([...this.failedLocalChanges]);
          }
        } catch {
          const next = attempts + 1;
          this.pendingLocalChanges.set(path, next);
          if (next >= ConfigChannel.MAX_CHANGE_ATTEMPTS) {
            if (!this.failedLocalChanges.has(path)) {
              this.failedLocalChanges.add(path);
              this.d.onChangeFailure?.([...this.failedLocalChanges]);
            }
          } else {
            needsRetry = true;
          }
        }
      }
      if (needsRetry) this.scheduleChangeDrain(250);
    } finally {
      this.changeDrainRunning = false;
      // Events that arrived after the snapshots above must get their own serialized pass.
      if (
        (this.pendingRemoteChanges.length > 0 ||
          [...this.pendingLocalChanges.values()].some(
            (attempts) => attempts < ConfigChannel.MAX_CHANGE_ATTEMPTS,
          )) &&
        this.changeRetryTimer === null
      ) {
        this.scheduleChangeDrain();
      }
    }
  }

  /**
   * Seed the config map from local disk at engine start.
   *
   * STAT-FILTERED. This used to read and hash EVERY config-zone file on every start, only for
   * `publish()` to find the sha unchanged and return. The zone holds each synced plugin's whole
   * bundle plus theme CSS, so that was tens of megabytes of IO and CPU per launch — ~27s measured
   * on a real Android device, blocking `start()` throughout.
   *
   * A file is skipped only when BOTH hold:
   *   - its (size, mtime) match what we recorded at the last bootstrap, AND
   *   - the shared map already carries a live entry for it.
   *
   * The second condition is the safety one: the cache only means "unchanged since we published
   * it", which is worthless if that published entry is not actually in hand (first run against a
   * new relay, or a discarded index snapshot). Without it, a file could stay unpublished forever.
   *
   * Same technique as git's index and rsync's quick check, and the same tradeoff: a write that
   * preserves BOTH size and mtime is missed here. The live watcher and the manual `rescan` command
   * both still catch it.
   */
  async bootstrap(): Promise<void> {
    const cached = (await this.d.engineState?.getConfigStats?.()) ?? {};
    const fresh: Record<string, ConfigStat> = {};

    for (const { path, size, mtime } of await this.d.configPort.list()) {
      if (!this.categoryEnabled(path) || !this.gateAllows(path)) continue; // skip disabled or gated
      const prev = cached[path];
      const entry = this.d.config.get(path);
      if (
        prev?.size === size &&
        prev.mtime === mtime &&
        entry !== undefined &&
        entry.deleted !== true
      ) {
        fresh[path] = prev; // unchanged AND already published — no read, no hash
        continue;
      }
      const bytes = await this.d.configPort.read(path);
      if (bytes !== null) {
        await this.publish(path, bytes);
        fresh[path] = { size, mtime };
      }
    }

    // ONE durable write for the whole pass. Paths absent from `fresh` (deleted, or newly gated
    // off) drop out of the cache naturally, so it cannot accumulate stale entries.
    await this.d.engineState?.setConfigStats?.(fresh);
  }

  private async onLocalChange(path: VaultPath): Promise<void> {
    if (!this.categoryEnabled(path)) return; // this device doesn't sync this category
    if (!this.gateAllows(path)) return;
    const bytes = await this.d.configPort.read(path);
    if (bytes === null) {
      if (configCategoryOf(path) === "plugin-data") return; // S3-11: never propagate a data.json delete (uninstall/atomic-save must not wipe peers)
      const prev = this.d.config.get(path);
      if (prev === undefined || prev.deleted === true) return; // nothing to tombstone / echo of our own remove
      this.d.config.set(path, { ...prev, deleted: true, deviceId: this.d.identity.deviceId() });
      return;
    }
    const sha256 = await configIdentitySha(path, bytes);
    if (this.d.echo.isEcho(path, sha256)) return; // our own materialize wrote this file (check FIRST)
    if (configCategoryOf(path) === "plugin-data") {
      const m = this.d.config.get(path)?.sha256 ?? null;
      const r = this.d.engineState ? await this.d.engineState.getConfigNormalizedSha(path) : null;
      const materialized =
        m !== null && (await this.d.blobStore.has(m))
          ? tryParseJson(await this.d.blobStore.get(m))
          : undefined;
      const local = tryParseJson(bytes);
      const decision: EchoDecision = classifyPluginDataChange({
        s: sha256,
        m,
        r,
        materialized,
        local,
        noisyKeys: NOISY_DATA_KEYS,
      });
      if (decision === "suppress") return;
      if (decision === "adopt-normalized") {
        if (this.d.engineState) await this.d.engineState.setConfigNormalizedSha(path, sha256);
        return; // a normalization (added defaults) — learn R, never republish
      }
      if (this.d.engineState) await this.d.engineState.setConfigNormalizedSha(path, null); // real user edit
    }
    await this.publish(path, bytes);
  }

  private async onRemoteChange(keys: string[]): Promise<void> {
    for (const key of keys) {
      if (!this.categoryEnabled(key as VaultPath)) continue; // disabled category: don't drive local removes
      const e = this.d.config.get(key);
      if (e?.deleted === true) {
        // m6: echo.recordWrite removed — it was dead. The remove triggers onChange with null bytes;
        // onLocalChange sees prev.deleted === true and returns early, so no spurious re-tombstone.
        // The dead echo entry could have falsely suppressed a later genuine write of the same sha.
        // S3-11: plugin-data tombstones are never authored (onLocalChange short-circuits), so this
        // branch never fires for plugin-data in practice — defensive note only, no logic change.
        await this.d.configPort.remove(key as VaultPath).catch(() => undefined);
      }
    }
  }
}
