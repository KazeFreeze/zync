import type { ConfigPort, Unsubscribe, VaultEvent, VaultPath, VaultPort } from "../ports.js";
import { isConfigZone } from "./config-entry.js";

/** VaultPort that diverts config-zone paths to a ConfigPort; everything else hits the inner vault. */
export class RoutedVault implements VaultPort {
  constructor(
    private readonly inner: VaultPort,
    private readonly config: ConfigPort,
  ) {}

  read(path: VaultPath): Promise<Uint8Array | null> {
    return isConfigZone(path) ? this.config.read(path) : this.inner.read(path);
  }
  writeAtomic(path: VaultPath, data: Uint8Array, opts?: { mtime?: number }): Promise<void> {
    return isConfigZone(path)
      ? this.config.writeAtomic(path, data)
      : this.inner.writeAtomic(path, data, opts);
  }
  remove(path: VaultPath): Promise<void> {
    return isConfigZone(path) ? this.config.remove(path) : this.inner.remove(path);
  }
  rename(from: VaultPath, to: VaultPath): Promise<void> {
    return this.inner.rename(from, to);
  }
  list(prefix?: VaultPath): Promise<{ path: VaultPath; size: number; mtime: number }[]> {
    return this.inner.list(prefix);
  }
  onEvent(cb: (e: VaultEvent) => void): Unsubscribe {
    return this.inner.onEvent(cb);
  }
  durabilityTrusted(): boolean {
    return this.inner.durabilityTrusted?.() ?? false;
  }
}
