/**
 * NodeFsCommunityPlugins — headless CommunityPluginsPort for `.obsidian/community-plugins.json`.
 *
 * Watches the `.obsidian/` directory for changes to `community-plugins.json` and provides
 * atomic read/write. Mirrors NodeFsConfig's watcher + atomic write pattern but for the ONE file.
 *
 * Change detection is layered:
 *   1. `fs.watch` on `.obsidian/` — fires quickly for host-native writes.
 *   2. A 2 s `setInterval` rescan backstop that compares raw file content to the
 *      last-seen string. This is the primary mechanism in Docker containers where
 *      bind-mount / overlayfs makes `fs.watch` unreliable.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { CommunityPluginsPort } from "@zync/core";
import { COMMUNITY_PLUGINS_PATH } from "@zync/core";
import { atomicWriteBytes, isEnoent } from "./fs-utils.js";

export class NodeFsCommunityPlugins implements CommunityPluginsPort {
  private readonly abs: string;
  private readonly cbs = new Set<() => void>();
  private watcher: fs.FSWatcher | null = null;
  private readonly scanTimer: ReturnType<typeof setInterval>;
  /** Last-seen raw file content (or null when absent). Used by the rescan backstop. */
  private lastContent: string | null;
  private closed = false;

  constructor(root: string) {
    this.abs = path.join(path.resolve(root), COMMUNITY_PLUGINS_PATH);

    // Best-effort sync read to initialise lastContent so the first rescan tick
    // does not fire spuriously for a file that hasn't changed since startup.
    try {
      this.lastContent = fs.readFileSync(this.abs, "utf8");
    } catch {
      this.lastContent = null;
    }

    try {
      this.watcher = fs.watch(path.dirname(this.abs), (_e, filename) => {
        if (filename !== null && path.basename(filename) === "community-plugins.json")
          for (const cb of this.cbs) cb();
      });
    } catch {
      this.watcher = null;
    }

    // Rescan backstop: poll the file every 2 s so changes that bypass fs.watch
    // (Docker bind-mount / overlayfs) are still detected.
    this.scanTimer = setInterval(() => {
      void this.tick();
    }, 2_000);
    // Unref so the interval does not prevent process exit (mirrors NodeFsConfig).
    if (typeof (this.scanTimer as { unref?: () => void }).unref === "function") {
      (this.scanTimer as { unref: () => void }).unref();
    }
  }

  async read(): Promise<string[] | null> {
    let txt: string;
    try {
      txt = await fsp.readFile(this.abs, "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      // Non-ENOENT IO error (permissions, etc.) — treat as an unreadable/absent file so ingest
      // skips (null), rather than fabricating an authoritative empty enabled-list.
      return null;
    }
    try {
      const arr = JSON.parse(txt) as unknown;
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      // Torn/corrupt JSON (e.g. a partial write observed mid-flight) — return null so the channel
      // skips ingest instead of reading it as "disable everything".
      return null;
    }
  }

  async writeAtomic(ids: string[]): Promise<void> {
    const serialized = JSON.stringify(ids, null, 2);
    await fsp.mkdir(path.dirname(this.abs), { recursive: true });
    await atomicWriteBytes(this.abs, new TextEncoder().encode(serialized));
    // Deliberately do NOT update lastContent here. writeAtomic is used by BOTH the channel's
    // projection AND the `community-write` control endpoint (which simulates a native toggle) —
    // suppressing rescan detection here would make the endpoint's write invisible. The channel
    // echo-guards its OWN projection writes via `lastProjected`, so a rescan fire for our own
    // write is harmlessly dropped there; an external write is correctly ingested.
  }

  onChange(cb: () => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    clearInterval(this.scanTimer);
    this.cbs.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.closed) return;
    let content: string | null;
    try {
      content = await fsp.readFile(this.abs, "utf8");
    } catch (err) {
      // On unexpected errors keep the last known value to avoid spurious fires.
      content = isEnoent(err) ? null : this.lastContent;
    }
    if (content !== this.lastContent) {
      this.lastContent = content;
      for (const cb of this.cbs) cb();
    }
  }
}
