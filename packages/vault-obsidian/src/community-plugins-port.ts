/**
 * ObsidianCommunityPlugins — CommunityPluginsPort implementation for on-device Obsidian.
 *
 * Reads/writes `.obsidian/community-plugins.json` via the Obsidian DataAdapter and watches for
 * external changes via the undocumented `vault.on("raw", cb)` event (mirrors ObsidianConfigPort's
 * watcher pattern). The raw watcher fires for ANY DataAdapter write Obsidian observes, filtered
 * here to the single community-plugins.json path.
 *
 * This is the Obsidian-side CommunityPluginsPort; the harness-proven headless port is
 * NodeFsCommunityPlugins (packages/headless-client). Both implement the same interface.
 */

import type { EventRef, Vault } from "obsidian";
import type { CommunityPluginsPort, Unsubscribe } from "@zync/core";

const PATH = ".obsidian/community-plugins.json";

/** Narrowly-typed interface for the undocumented vault.on("raw", cb) API. */
interface RawVault {
  on(name: "raw", cb: (path: string) => void): EventRef;
}

export class ObsidianCommunityPlugins implements CommunityPluginsPort {
  private readonly cbs = new Set<() => void>();
  private readonly refs: EventRef[] = [];

  constructor(private readonly vault: Vault) {
    // Subscribe to the "raw" watcher, filtered to the community-plugins.json path.
    const ref = (vault as unknown as RawVault).on("raw", (p: string) => {
      if (p === PATH) for (const cb of this.cbs) cb();
    });
    this.refs.push(ref);
  }

  async read(): Promise<string[] | null> {
    const a = this.vault.adapter;
    if (!(await a.exists(PATH))) return null;
    try {
      const arr = JSON.parse(await a.read(PATH)) as unknown;
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      // Torn/corrupt read (partial write observed mid-flight, or unreadable) — return null so the
      // channel skips ingest instead of reading it as an authoritative "disable everything".
      return null;
    }
  }

  async writeAtomic(ids: string[]): Promise<void> {
    // vault.adapter.write is the Obsidian DataAdapter's plain write — suitable for dot-folder files.
    // Obsidian's DataAdapter handles atomic write internally (or as close as Obsidian gets).
    await this.vault.adapter.write(PATH, JSON.stringify(ids, null, 2));
  }

  onChange(cb: () => void): Unsubscribe {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  close(): void {
    const rv = this.vault as unknown as { offref(ref: EventRef): void };
    for (const ref of this.refs) rv.offref(ref);
    this.refs.length = 0;
    this.cbs.clear();
  }
}
