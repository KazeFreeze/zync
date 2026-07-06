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
import { configCategoryOf, type ConfigEntry } from "./config-entry.js";

export interface ConfigChannelDeps {
  config: CrdtMap<ConfigEntry>;
  blobStore: BlobStorePort;
  configPort: ConfigPort;
  identity: IdentityPort;
  echo: EchoLedger;
  /** Which config categories this device syncs. Absent category = not published or materialized. */
  enabledCategories: { themes: boolean; snippets: boolean };
}

/**
 * Config-zone (themes/snippets) sync coordinator. Detection + IO happen through the ConfigPort
 * (the prose VaultPort is blind to `.obsidian/**`). Local changes -> publish; local deletes ->
 * tombstone; remote tombstones -> remove the local file. Live remote content is materialized by the
 * shared BlobEngine (via RoutedManifest + RoutedVault), not here.
 */
export class ConfigChannel {
  constructor(private readonly d: ConfigChannelDeps) {}

  /** Returns true when this device syncs files in the given path's category. */
  private categoryEnabled(path: VaultPath): boolean {
    const c = configCategoryOf(path);
    return c !== undefined && this.d.enabledCategories[c];
  }

  /** Content-address, store once, publish a ConfigEntry (idempotent on identical content). */
  async publish(path: VaultPath, bytes: Uint8Array): Promise<void> {
    if (!this.categoryEnabled(path)) return;
    const category = configCategoryOf(path);
    if (category === undefined) return;
    const sha256 = await sha256OfBytes(bytes);
    const cur = this.d.config.get(path);
    if (cur !== undefined && cur.deleted !== true && cur.sha256 === sha256) return; // no-op churn guard
    if (!(await this.d.blobStore.has(sha256))) await this.d.blobStore.put(sha256, bytes);
    this.d.config.set(path, {
      sha256,
      size: bytes.length,
      category,
      deviceId: this.d.identity.deviceId(),
    });
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
      if (!this.categoryEnabled(path)) continue; // skip disabled categories
      const bytes = await this.d.configPort.read(path);
      if (bytes !== null) await this.publish(path, bytes);
    }
  }

  private async onLocalChange(path: VaultPath): Promise<void> {
    if (!this.categoryEnabled(path)) return; // this device doesn't sync this category
    const bytes = await this.d.configPort.read(path);
    if (bytes === null) {
      const prev = this.d.config.get(path);
      if (prev === undefined || prev.deleted === true) return; // nothing to tombstone / echo of our own remove
      this.d.config.set(path, { ...prev, deleted: true, deviceId: this.d.identity.deviceId() });
      return;
    }
    const sha256 = await sha256OfBytes(bytes);
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
        await this.d.configPort.remove(key as VaultPath).catch(() => undefined);
      }
    }
  }
}
