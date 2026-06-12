import type { VaultEvent, VaultPath, VaultPort, Unsubscribe } from "../ports.js";

interface Entry {
  data: Uint8Array;
  mtime: number;
}

export class FakeVault implements VaultPort {
  private files = new Map<string, Entry>();
  private listeners = new Set<(e: VaultEvent) => void>();
  private clock = 0;

  read(path: VaultPath): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(path)?.data ?? null);
  }

  writeAtomic(path: VaultPath, data: Uint8Array, opts?: { mtime?: number }): Promise<void> {
    const existed = this.files.has(path);
    this.files.set(path, { data, mtime: opts?.mtime ?? ++this.clock });
    this.emit({ type: existed ? "modify" : "create", path });
    return Promise.resolve();
  }

  remove(path: VaultPath): Promise<void> {
    if (this.files.delete(path)) this.emit({ type: "delete", path });
    return Promise.resolve();
  }

  rename(from: VaultPath, to: VaultPath): Promise<void> {
    const e = this.files.get(from);
    if (e) {
      this.files.delete(from);
      this.files.set(to, e);
      this.emit({ type: "rename", path: to, oldPath: from });
    }
    return Promise.resolve();
  }

  list(prefix?: VaultPath): Promise<{ path: VaultPath; size: number; mtime: number }[]> {
    const out: { path: VaultPath; size: number; mtime: number }[] = [];
    for (const [path, e] of this.files) {
      if (prefix !== undefined && !path.startsWith(prefix)) continue;
      out.push({ path: path as VaultPath, size: e.data.length, mtime: e.mtime });
    }
    return Promise.resolve(out);
  }

  onEvent(cb: (e: VaultEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: VaultEvent): void {
    for (const l of this.listeners) l(e);
  }
}
