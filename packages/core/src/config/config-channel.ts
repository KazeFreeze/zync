import type {
  BlobStorePort,
  CrdtMap,
  ConfigPort,
  IdentityPort,
  Unsubscribe,
  VaultPath,
} from "../ports.js";
import type { EchoLedger } from "../bridge/echo.js";
import { sha256OfBytes } from "../hash.js";
import { canonicalJsonBytes, configIdentitySha } from "./canonical.js";
import { configCategoryOf, pluginIdOf, type ConfigEntry } from "./config-entry.js";

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
  /** Monotonic clock for quiescence tracking. */
  now(): number;
}

/**
 * Config-zone (themes/snippets) sync coordinator. Detection + IO happen through the ConfigPort
 * (the prose VaultPort is blind to `.obsidian/**`). Local changes -> publish; local deletes ->
 * tombstone; remote tombstones -> remove the local file. Live remote content is materialized by the
 * shared BlobEngine (via RoutedManifest + RoutedVault), not here.
 */
export class ConfigChannel {
  private static readonly QUIESCENCE_MS = 1500;
  private readonly recentlyMaterialized = new Map<string, number>();

  constructor(private readonly d: ConfigChannelDeps) {}

  /** Called by the engine right after it materializes a plugin-data file. */
  noteMaterialized(path: VaultPath, at: number): void {
    if (configCategoryOf(path) === "plugin-data") this.recentlyMaterialized.set(path, at);
  }

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
    const isData = category === "plugin-data";
    const content = isData ? canonicalJsonBytes(bytes) : bytes;
    const sha256 = await sha256OfBytes(content);
    const cur = this.d.config.get(path);
    if (cur !== undefined && cur.deleted !== true && cur.sha256 === sha256) return; // canonical churn guard
    if (!(await this.d.blobStore.has(sha256))) await this.d.blobStore.put(sha256, content);
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
    this.d.config.set(path, {
      sha256,
      size: content.length,
      category,
      deviceId: this.d.identity.deviceId(),
      ...(version !== undefined ? { version } : {}),
      ...(newDataVersion !== undefined ? { dataVersion: newDataVersion } : {}),
    });
    if (isData && newDataVersion !== undefined && this.d.engineState !== undefined) {
      await this.d.engineState.setConfigLocalVersion(path, newDataVersion);
    }
  }

  /** Subscribe to local config-file changes AND remote config-map tombstones. */
  start(): Unsubscribe {
    const u1 = this.d.configPort.onChange((path) => {
      void this.onLocalChange(path);
    });
    const u2 = this.d.config.observe((keys) => {
      void this.onRemoteChange(keys);
    });
    return () => {
      u1();
      u2();
    };
  }

  /** Seed the config map from local disk at engine start. */
  async bootstrap(): Promise<void> {
    for (const { path } of await this.d.configPort.list()) {
      if (!this.categoryEnabled(path) || !this.gateAllows(path)) continue; // skip disabled or gated
      const bytes = await this.d.configPort.read(path);
      if (bytes !== null) await this.publish(path, bytes);
    }
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
    if (configCategoryOf(path) === "plugin-data") {
      const mAt = this.recentlyMaterialized.get(path);
      if (mAt !== undefined && this.d.now() - mAt < ConfigChannel.QUIESCENCE_MS) {
        this.recentlyMaterialized.delete(path); // consume once; adopt this re-save silently
        return;
      }
    }
    const sha256 = await configIdentitySha(path, bytes);
    if (this.d.echo.isEcho(path, sha256)) return; // our own materialize wrote this file
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
