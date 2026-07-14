import type { CrdtMap, Unsubscribe } from "../ports.js";
import type { PluginMeta } from "./plugin-maps.js";
import { projectArray, ingestEnabled, managedSet, arraysEqual } from "./plugins-projection.js";

/** Read/write/watch the ONE `.obsidian/community-plugins.json` file (a JSON array of enabled plugin ids). */
export interface CommunityPluginsPort {
  read(): Promise<string[] | null>;
  writeAtomic(ids: string[]): Promise<void>;
  onChange(cb: () => void): Unsubscribe;
  close(): void;
}

export interface PluginEnabledChannelDeps {
  optIn: CrdtMap<boolean>;
  enabled: CrdtMap<boolean>;
  meta: CrdtMap<PluginMeta>;
  port: CommunityPluginsPort;
  isMobile: boolean;
  suppress: () => Set<string>;
}

/** Bidirectional projection between the shared `pluginsEnabled` map and `community-plugins.json`. */
export class PluginEnabledChannel {
  private lastProjected: string[] | null = null;
  constructor(private readonly d: PluginEnabledChannelDeps) {}

  /** Ids with a `true` opt-in entry (shared consent). */
  private optInSet(): Set<string> {
    const optIn = new Set<string>();
    for (const [id, v] of this.d.optIn.entries()) if (v) optIn.add(id);
    return optIn;
  }

  /** Ids whose shared meta marks them desktop-only. */
  private desktopOnlySet(): Set<string> {
    const desktopOnly = new Set<string>();
    for (const [id, m] of this.d.meta.entries()) if (m.isDesktopOnly) desktopOnly.add(id);
    return desktopOnly;
  }

  /**
   * The "ingest managed" set: opted-in ∧ platform-allowed ∧ ¬suppressed.
   * Ingest only reads managed ids so a suppressed plugin absent from the array
   * does NOT set a shared-disable (the non-leaking invariant).
   */
  private managed(): Set<string> {
    return managedSet(this.optInSet(), this.desktopOnlySet(), this.d.suppress(), this.d.isMobile);
  }

  /**
   * The "project managed" set: opted-in ∧ platform-allowed (suppress NOT excluded).
   * Suppressed plugins are still "owned" by Zync for projection — they are forced-disabled
   * on this device (the enabled callback returns false) so they get removed from the array.
   * Platform-excluded plugins are left as local-only (preserve).
   */
  private projectManaged(): Set<string> {
    // Include suppressed ids (they'll be force-disabled below), exclude platform-excluded.
    return managedSet(this.optInSet(), this.desktopOnlySet(), new Set(), this.d.isMobile);
  }

  /** Outbound: recompute + write the array if it changed. */
  reproject(): void {
    void this.project();
  }

  private async project(): Promise<void> {
    const managed = this.projectManaged();
    const suppress = this.d.suppress();
    const current = (await this.d.port.read()) ?? [];
    // Suppressed plugins are managed but force-disabled: they are removed from this device's array.
    const next = projectArray(
      current,
      managed,
      (id) => this.d.enabled.get(id) === true && !suppress.has(id),
    );
    if (arraysEqual(current, next)) return; // nothing to write
    this.lastProjected = next;
    await this.d.port.writeAtomic(next);
  }

  /** Inbound: ingest an external community-plugins.json change into pluginsEnabled (managed ids only). */
  private async ingest(): Promise<void> {
    // A null read means the file is ABSENT or unreadable/corrupt — NOT an authoritative "disable
    // everything". Skip: coercing null to [] here would set enabled=false for every managed id and
    // replicate a shared-disable to all devices. A genuine disable-all writes a present, parseable [].
    const arr = await this.d.port.read();
    if (arr === null) return;
    if (this.lastProjected !== null && arraysEqual(arr, this.lastProjected)) return; // echo of our own write
    const deltas = ingestEnabled(arr, this.managed());
    for (const [id, v] of deltas) if (this.d.enabled.get(id) !== v) this.d.enabled.set(id, v);
    // Defensive: if the external edit was a net-zero managed delta (e.g. re-adding a SUPPRESSED id,
    // which ingest ignores so no enabled.observe re-projects), re-assert Zync's owned state. Loop-safe:
    // project()'s arraysEqual short-circuits once converged, and any write sets lastProjected so the
    // resulting onChange is echo-dropped.
    this.reproject();
  }

  start(): Unsubscribe {
    const u1 = this.d.enabled.observe(() => {
      this.reproject();
    });
    const u2 = this.d.optIn.observe(() => {
      this.reproject();
    });
    const u3 = this.d.meta.observe(() => {
      this.reproject();
    });
    const u4 = this.d.port.onChange(() => void this.ingest());
    this.reproject(); // project current state on start (in case maps were set before start())
    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }
}
