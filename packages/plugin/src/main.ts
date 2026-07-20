import { Plugin, Platform, PluginSettingTab, Setting, Notice, type App } from "obsidian";
import {
  SyncEngine,
  isActionableConflict,
  type ClockPort,
  type DeviceId,
  type IdentityPort,
} from "@zync/core";
import { ConflictInboxModal } from "./conflict-inbox-modal.js";
import { PendingUpdatesModal } from "./pending-updates-modal.js";
import { YjsCrdtProvider, HocuspocusTransport } from "@zync/crdt-yjs";
import { HttpBlobStore } from "@zync/blob-http";
import {
  openZyncDb,
  closeZyncDb,
  IdbDocStore,
  IdbEngineState,
  DEFAULT_ZYNC_DB_NAME,
  type ZyncDb,
} from "@zync/store-idb";
import {
  ObsidianVaultPort,
  ObsidianEditorBinding,
  ObsidianConfigPort,
  ObsidianCommunityPlugins,
  ObsidianPluginRuntime,
} from "@zync/vault-obsidian";
import type { PluginRuntimePort } from "@zync/core";
import { PortProfiler } from "./profiling.js";
import { overrideState } from "./plugin-override-state.js";
import { ConnectionAlert, type AlertCommand } from "./connection-alert.js";

/**
 * Zync plugin — M1 desktop walking skeleton (M1-T5 wiring).
 *
 * Constructs the validated SyncEngine from the Obsidian adapters + IndexedDB stores + the Hocuspocus
 * transport, binds live editors (the active-bound FileAuthority FSM), and surfaces conn/pending status +
 * sync conflicts. Engine lifecycle is gated on `workspace.onLayoutReady` (the startup-create trap) and torn
 * down on unload.
 *
 * Real on-device behavior (editing, undo/IME, convergence, .obsidian/zync access) is the manual gate — see
 * docs/superpowers/notes/2026-06-17-zync-m1-dev-loop-runbook.md.
 */

interface ZyncSettings {
  /** Relay WebSocket URL, e.g. ws://localhost:1234 */
  serverWs: string;
  /** Blob HTTP base URL, e.g. http://localhost:8080 */
  serverHttp: string;
  /** Static auth token shared with the relay + blob endpoint (M1; per-device tokens are M4). */
  token: string;
  /** Human-friendly device name (shown to peers later). */
  deviceName: string;
  /** Stable per-install device id — auto-generated on first run, never user-edited. */
  deviceId: string;
  /** Config-zone sync toggles. Defaults OFF for themes/snippets, ON for plugins (the per-plugin
   *  opt-in map is the real gate so nothing syncs until a plugin is explicitly opted in).
   *  Restart required to apply. */
  syncConfig: { themes: boolean; snippets: boolean; plugins: boolean; "plugin-data": boolean };
}

const DEFAULT_SETTINGS: ZyncSettings = {
  serverWs: "",
  serverHttp: "",
  token: "",
  deviceName: "obsidian-desktop",
  deviceId: "",
  syncConfig: { themes: false, snippets: false, plugins: true, "plugin-data": true },
};

const CONFIG_DIR = ".obsidian/zync"; // vault-relative; the BaseStore zone ObsidianVaultPort excludes
const MAX_PROSE_BYTES = 1_000_000;

/**
 * How often (ms) to poll engine.pendingDocs() for the status bar.
 *
 * pendingDocs() is an O(n) disk-read scan — intentionally authoritative but expensive. During a
 * large first-sync (~1000+ notes) polling at 2 s produced ~450-900 full scans over the sync
 * window. 8 s is still plenty fresh for a "N pending" indicator; connect/disconnect updates arrive
 * push-style via transport.onStatus and are unaffected by this constant.
 */
const STATUS_POLL_INTERVAL_MS = 8_000;

export default class ZyncPlugin extends Plugin {
  override settings: ZyncSettings = { ...DEFAULT_SETTINGS };

  private engine: SyncEngine | null = null;
  private editorBinding: ObsidianEditorBinding | null = null;
  private vault: ObsidianVaultPort | null = null;
  private configPort: ObsidianConfigPort | null = null;
  private communityPluginsPort: ObsidianCommunityPlugins | null = null;
  /** Slice 2b: live app.plugins runtime wrapper for the apply reconciler. */
  private runtime: PluginRuntimePort | null = null;
  /** Slice 2b: unsubscribe fn for the onPluginsChanged reconciler subscription. */
  private reconcileUnsub: (() => void) | null = null;
  /** Task 8: unsubscribe fn for onPendingUpdates (status-bar refresh). */
  private pendingUpdatesUnsub: (() => void) | null = null;
  /** Task 8: unsubscribe fn for onPluginCodeMaterialized (first-time activation retry / real-update staging). */
  private pluginMatUnsub: (() => void) | null = null;
  /** Slice 3b: unsubscribe fn for onPluginDataMaterialized (live-apply or stage settings updates). */
  private pluginDataMatUnsub: (() => void) | null = null;
  private transport: HocuspocusTransport | null = null;
  private db: ZyncDb | null = null;
  private dbName: string | null = null;
  private statusBar: HTMLElement | null = null;
  private statusTimer: number | null = null;
  /** Guards against concurrent pendingDocs() scans when a poll takes longer than the interval. */
  private statusRefreshInFlight = false;
  /** Last computed pending count — rendered immediately on a connText push so a status change is
   *  reflected without waiting for the next (coarse, possibly skipped) expensive scan. */
  private lastPending = 0;
  private readonly unsubs: (() => void)[] = [];
  private connText = "offline";
  private lastConflictCount = 0;
  /** True only AFTER engine.start() completes. Gates status-bar reads of blobProgress()/inbox —
   *  both are undefined until start() finishes, and onStatus can drive renderStatus mid-start. */
  private engineReady = false;
  /** Per-session port timing (recreated each startEngine); dumped by "Zync: dump bootstrap profile". */
  private profiler: PortProfiler | null = null;
  /** Mobile-only connection-alert state machine + its single sticky Notice + debounce timer. */
  private alert: ConnectionAlert | null = null;
  private stickyNotice: Notice | null = null;
  private alertTimer: number | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.statusBar = this.addStatusBarItem();
    this.renderStatus(0);
    if (this.statusBar !== null) {
      this.statusBar.style.cursor = "pointer";
      // Route to pending-updates modal when there are staged plugin updates; inbox otherwise.
      this.statusBar.addEventListener("click", () => {
        if (
          this.engineReady &&
          this.engine !== null &&
          this.engine.pendingPluginUpdates().length > 0
        ) {
          this.openPendingUpdates();
        } else {
          this.openInbox();
        }
      });
    }

    this.addSettingTab(new ZyncSettingTab(this.app, this));
    this.addCommand({
      // id kept stable (avoids breaking any saved hotkey); the name reflects the browse+resolve inbox.
      id: "zync-show-conflicts",
      name: "Zync: open sync inbox",
      callback: () => {
        this.openInbox();
      },
    });
    this.addCommand({
      id: "zync-pending-updates",
      name: "Zync: pending plugin updates",
      callback: () => {
        this.openPendingUpdates();
      },
    });
    this.addCommand({
      id: "zync-restart",
      name: "Zync: restart sync",
      callback: () => {
        void this.restart();
      },
    });
    this.addCommand({
      id: "zync-rescan-config",
      name: "Zync: rescan config",
      callback: () => {
        void this.engine?.rescanConfig();
      },
    });
    this.addCommand({
      id: "zync-reflush",
      name: "Zync: re-verify sync (reflush)",
      callback: () => {
        this.engine?.requestSelfHeal();
      },
    });
    this.addCommand({
      id: "zync-dump-profile",
      name: "Zync: dump bootstrap profile",
      callback: () => {
        const report = this.profiler?.report() ?? "Zync: profiler inactive (engine not started).";
        // eslint-disable-next-line no-console
        console.log(report);
        new Notice("Zync: bootstrap profile dumped to the developer console (Ctrl+Shift+I).");
      },
    });

    this.addCommand({
      id: "zync-show-status",
      name: "Zync: show status",
      callback: () => {
        new Notice(this.currentStatusText(), 4000);
      },
    });

    // Mobile edit-while-disconnected bypass: feed editor changes to the connection alert.
    if (Platform.isMobile) {
      this.registerEvent(this.app.workspace.on("editor-change", () => this.alert?.onEdit()));
    }

    // Gate engine start on layout-ready so Obsidian's startup file inventory doesn't flood ingest as
    // user creates (and so the editor binding doesn't bind before the engine exists).
    this.app.workspace.onLayoutReady(() => {
      void this.startEngine();
    });
  }

  override async onunload(): Promise<void> {
    await this.stopEngine();
  }

  // ── engine lifecycle ───────────────────────────────────────────────────────

  private async startEngine(): Promise<void> {
    if (this.engine !== null) return;
    if (this.settings.serverWs === "") {
      this.connText = "not configured";
      this.renderStatus(0);
      new Notice("Zync: set the relay URL in Settings → Zync to start syncing.");
      return;
    }

    try {
      this.dbName = `${DEFAULT_ZYNC_DB_NAME}-${this.settings.deviceId}`;
      this.db = await openZyncDb(this.dbName);

      // Bootstrap profiling: wrap the persistence ports so "Zync: dump bootstrap profile" attributes
      // first-sync wall-time to real IndexedDB (docStore/engineState) vs the Obsidian DataAdapter
      // (vault) — the split harness:scale (node FS stores) cannot measure. Transparent; ~µs overhead.
      const profiler = new PortProfiler();
      this.profiler = profiler;
      this.vault = profiler.wrap("vault", new ObsidianVaultPort(this.app.vault));
      const crdt = new YjsCrdtProvider();
      const transport = new HocuspocusTransport({
        url: this.settings.serverWs,
        ...(this.settings.token !== "" ? { token: this.settings.token } : {}),
        connect: true,
      });
      this.transport = transport; // plugin owns it — engine.stop() does NOT close it (see stopEngine)
      const blobs = new HttpBlobStore(this.settings.serverHttp, this.settings.token);
      const docStore = profiler.wrap("docStore", new IdbDocStore(this.db));
      const engineState = profiler.wrap("engineState", new IdbEngineState(this.db));
      const clock: ClockPort = { now: () => Date.now() };
      const identity: IdentityPort = {
        deviceId: () => this.settings.deviceId as DeviceId,
        deviceName: () => this.settings.deviceName,
      };

      // Construct the config port only when at least one category toggle is on.
      // Gated here (not in the constructor) so the port — which registers a "raw" watcher —
      // is never created when no config sync is requested.
      let configPort: ObsidianConfigPort | undefined;
      if (
        this.settings.syncConfig.themes ||
        this.settings.syncConfig.snippets ||
        this.settings.syncConfig.plugins
      ) {
        configPort = new ObsidianConfigPort(this.app.vault);
        this.configPort = configPort;
      }

      // Slice 2b: the live app.plugins runtime wrapper (always constructed — used by the reconciler).
      const runtime = new ObsidianPluginRuntime(this.app);
      this.runtime = runtime;

      // Slice 2b: construct the community-plugins.json port only when the plugins toggle is on.
      // Gated the same way as configPort (registers a "raw" watcher; no cost when not needed).
      let communityPluginsPort: ObsidianCommunityPlugins | undefined;
      if (this.settings.syncConfig.plugins) {
        communityPluginsPort = new ObsidianCommunityPlugins(this.app.vault);
        this.communityPluginsPort = communityPluginsPort;
      }

      const engine = new SyncEngine(
        {
          vault: this.vault,
          crdt,
          transport,
          blobs,
          docStore,
          clock,
          identity,
          engineState,
          ...(configPort !== undefined ? { config: configPort } : {}),
          ...(communityPluginsPort !== undefined ? { communityPlugins: communityPluginsPort } : {}),
        },
        // blobPolicy "eager": a desktop device materializes synced blobs to disk (parity with the
        // headless peer's default). Blobs-at-scale + lazy mobile fetch are M2.
        {
          configDir: CONFIG_DIR,
          maxProseBytes: MAX_PROSE_BYTES,
          blobPolicy: "eager",
          // Thread the per-category toggle through to ConfigChannel + RoutedManifest so
          // a device with "snippets on, themes off" never uploads or downloads theme files.
          configCategories: this.settings.syncConfig,
          isMobile: Platform.isMobile,
        },
      );
      this.engine = engine;

      if (Platform.isMobile) {
        this.alert = new ConnectionAlert({
          now: () => Date.now(),
          emit: (cmd) => this.execAlert(cmd),
          pending: () => this.lastPending,
        });
      }
      this.unsubs.push(
        transport.onStatus((s) => {
          this.connText = s;
          this.alert?.onConn(s === "connected");
          void this.refreshStatus();
        }),
      );

      await engine.start();
      this.engineReady = true; // blobProgress()/inbox are now valid to read from renderStatus

      // Slice 2b: wire the live apply reconciler. Fires on any change to the desired-active set
      // (enabled/optIn/meta/suppress maps), then does a single diff-and-apply pass. The
      // community-plugins.json projection (floor) is already wired inside the engine via the
      // PluginEnabledChannel; this is the fast-path live apply on top of it.
      if (this.settings.syncConfig.plugins) {
        this.reconcileUnsub = engine.onPluginsChanged(() => {
          this.reconcilePlugins();
        });
        // Task 8: when a desired-active plugin's code materializes, decide here (where the live
        // running set is available): a plugin ALREADY running -> stage a real pending update; a
        // FIRST-TIME plugin -> re-run the reconciler now that its files are present (the initial
        // enable() may have raced ahead of materialization and failed silently). Reconcile is
        // idempotent + cheap, so firing once per bundle file converges once all files are present.
        this.pluginMatUnsub = engine.onPluginCodeMaterialized((id) => {
          if (id === this.manifest.id) return; // never reload ourselves mid-flight (self-reload guard)
          const running = new Set(this.runtime?.enabledIds() ?? []);
          if (running.has(id)) engine.addPendingUpdate(id);
          else this.reconcilePlugins();
        });
        this.pluginDataMatUnsub = engine.onPluginDataMaterialized((id) => {
          if (id === this.manifest.id) return; // never reload ourselves mid-flight (self-reload guard)
          const running = new Set(this.runtime?.enabledIds() ?? []);
          if (!running.has(id)) return; // not running → loads on next activation (the safe floor)
          void this.runtime
            ?.applyExternalSettings(id)
            .then((applied) => {
              if (!applied) engine.addPendingUpdate(id);
            }) // no live hook → stage a reload
            .catch(() => engine.addPendingUpdate(id));
        });
        // Run once immediately post-start to apply any desired state that arrived before this device
        // started (e.g. another device enabled a plugin while this one was offline).
        this.reconcilePlugins();
      }

      // Task 8: refresh the status bar whenever a pending plugin-update arrives or is cleared.
      this.pendingUpdatesUnsub = engine.onPendingUpdates(() => {
        this.renderStatus(this.lastPending);
      });

      // Surface sync conflicts as they land.
      this.unsubs.push(
        engine.inbox.observe(() => {
          this.refreshConflictNotice();
        }),
      );

      this.editorBinding = new ObsidianEditorBinding(this.app, engine);
      this.editorBinding.start();

      // Poll pending count for the status bar. Tracked so stopEngine clears it — registerInterval
      // alone would leak one timer per restart. Coarse cadence (STATUS_POLL_INTERVAL_MS) because
      // pendingDocs() is O(n) disk I/O; connection status arrives push-style via onStatus above.
      this.statusTimer = window.setInterval(
        () => void this.refreshStatus(),
        STATUS_POLL_INTERVAL_MS,
      );
      void this.refreshStatus();
      console.log("[zync] engine started");
    } catch (err) {
      console.error("[zync] failed to start engine:", err);
      this.connText = "error";
      this.renderStatus(0);
      new Notice(`Zync: failed to start. ${err instanceof Error ? err.message : String(err)}`);
      await this.stopEngine();
    }
  }

  private async stopEngine(): Promise<void> {
    this.engineReady = false; // stop reading blobProgress()/inbox during + after teardown
    if (this.alertTimer !== null) {
      window.clearTimeout(this.alertTimer);
      this.alertTimer = null;
    }
    this.stickyNotice?.hide();
    this.stickyNotice = null;
    this.alert = null;
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    // Reset the in-flight guard so a mid-poll stop doesn't permanently block polling after restart.
    this.statusRefreshInFlight = false;
    // Reset the cached pending count so a restart doesn't briefly render a stale number.
    this.lastPending = 0;
    this.editorBinding?.stop();
    this.editorBinding = null;
    for (const u of this.unsubs.splice(0)) u();
    // Slice 2b: unsubscribe the reconciler BEFORE engine.stop() so its CRDT observers are
    // unregistered while the index doc is still live (stop() destroys the doc). Then drop the
    // runtime — no more app.plugins calls after teardown.
    this.reconcileUnsub?.();
    this.reconcileUnsub = null;
    // Task 8: unsubscribe the pending-updates + code-materialized listeners before engine.stop()
    // clears their callback sets.
    this.pendingUpdatesUnsub?.();
    this.pendingUpdatesUnsub = null;
    this.pluginMatUnsub?.();
    this.pluginMatUnsub = null;
    this.pluginDataMatUnsub?.();
    this.pluginDataMatUnsub = null;
    this.runtime = null;
    if (this.engine !== null) {
      try {
        await this.engine.stop();
      } catch (err) {
        console.error("[zync] engine stop error:", err);
      }
      this.engine = null;
    }
    // The plugin OWNS the transport — engine.stop() does NOT close it — so close it here, else each
    // restart leaks a socket + reconnect loop (mirrors the daemon's stop -> transport.close order).
    if (this.transport !== null) {
      try {
        await this.transport.close();
      } catch (err) {
        console.error("[zync] transport close error:", err);
      }
      this.transport = null;
    }
    // Slice 2b: close the community-plugins port. engine.stop() already closed it (the engine holds
    // the same port in its EnginePorts and closes it during teardown), so this is a harmless,
    // idempotent second close — close() clears its watcher refs + callbacks and is safe to re-run.
    this.communityPluginsPort?.close();
    this.communityPluginsPort = null;
    this.configPort?.close();
    this.configPort = null;
    this.vault?.close();
    this.vault = null;
    this.profiler = null;
    if (this.dbName !== null) {
      closeZyncDb(this.dbName);
      this.dbName = null;
    }
    this.db = null;
    this.lastConflictCount = 0;
  }

  async restart(): Promise<void> {
    await this.stopEngine();
    await this.startEngine();
  }

  // ── status + conflicts ───────────────────────────────────────────────────────

  private async refreshStatus(): Promise<void> {
    // Render the CHEAP current state immediately (connText + last-known pending). This path runs on
    // every call — including the push-driven onStatus calls — so a connection change is reflected
    // at once, even while an expensive scan below is in-flight (or skipped).
    this.renderStatus(this.lastPending);
    // Skip the EXPENSIVE O(n) pendingDocs() scan if a previous one is still running — prevents
    // unbounded pileup during a large first-sync where a single scan can exceed the poll interval.
    if (this.statusRefreshInFlight) return;
    this.statusRefreshInFlight = true;
    try {
      if (this.engine !== null) {
        try {
          this.lastPending = (await this.engine.pendingDocs()).length;
        } catch {
          // engine stopped mid-poll — ignore
        }
      }
      this.renderStatus(this.lastPending);
    } finally {
      this.statusRefreshInFlight = false;
    }
  }

  private renderStatus(pending: number): void {
    // blobProgress() and inbox are only valid once start() completes; onStatus can drive
    // renderStatus mid-start, so gate both reads on engineReady (else they throw on undefined).
    const engine = this.engineReady ? this.engine : null;
    const b = engine?.blobProgress();
    const files =
      b && b.total > 0 && b.materialized < b.total
        ? ` · Files ${String(Math.min(b.materialized, b.total))}/${String(b.total)}` +
          (b.failed > 0 ? ` (${String(b.failed)} failed)` : "")
        : "";
    const nConf = engine ? engine.inbox.list().filter(isActionableConflict).length : 0;
    const conf = nConf > 0 ? ` · ⚠ ${String(nConf)}` : "";
    // Task 8: append ⟳ N when there are staged plugin-code updates waiting to be applied.
    const nUpdates = engine ? engine.pendingPluginUpdates().length : 0;
    const updates = nUpdates > 0 ? ` · ⟳ ${String(nUpdates)}` : "";
    this.statusBar?.setText(this.statusText(pending, files, conf, updates));
  }

  /** Compose the status line (shared by the desktop status bar and the "Zync: show status" command). */
  private statusText(pending: number, files: string, conf: string, updates: string): string {
    return `Zync: ${this.connText}${pending > 0 ? ` · ${String(pending)} pending` : ""}${files}${conf}${updates}`;
  }

  /** Full current status line from live state — for the on-demand "Zync: show status" command. */
  private currentStatusText(): string {
    const engine = this.engineReady ? this.engine : null;
    const b = engine?.blobProgress();
    const files =
      b && b.total > 0 && b.materialized < b.total
        ? ` · Files ${String(Math.min(b.materialized, b.total))}/${String(b.total)}` +
          (b.failed > 0 ? ` (${String(b.failed)} failed)` : "")
        : "";
    const nConf = engine ? engine.inbox.list().filter(isActionableConflict).length : 0;
    const conf = nConf > 0 ? ` · ⚠ ${String(nConf)}` : "";
    const nUpdates = engine ? engine.pendingPluginUpdates().length : 0;
    const updates = nUpdates > 0 ? ` · ⟳ ${String(nUpdates)}` : "";
    return this.statusText(this.lastPending, files, conf, updates);
  }

  /** Execute a ConnectionAlert command as Obsidian Notices/timers (mobile only). */
  private execAlert(cmd: AlertCommand): void {
    switch (cmd.kind) {
      case "showSticky":
        this.stickyNotice?.hide();
        this.stickyNotice = new Notice(cmd.message, 0);
        this.stickyNotice.noticeEl.addEventListener("click", () => {
          this.stickyNotice?.hide();
          this.stickyNotice = null;
          this.alert?.onDismiss();
        });
        break;
      case "hideSticky":
        this.stickyNotice?.hide();
        this.stickyNotice = null;
        break;
      case "toast":
        new Notice(cmd.message, cmd.durationMs);
        break;
      case "setTimer":
        if (this.alertTimer !== null) {
          window.clearTimeout(this.alertTimer);
          this.alertTimer = null;
        }
        if (cmd.atMs !== null) {
          const delay = Math.max(0, cmd.atMs - Date.now());
          this.alertTimer = window.setTimeout(() => {
            this.alertTimer = null;
            this.alert?.onTimer();
          }, delay);
        }
        break;
    }
  }

  private refreshConflictNotice(): void {
    // Notice ONLY when the actionable count GROWS, so churn/FYIs don't spam escalating popups.
    const n = this.engine?.inbox.list().filter(isActionableConflict).length ?? 0;
    if (n > this.lastConflictCount) {
      new Notice(`Zync: ${String(n)} item(s) need attention. Click the status bar.`);
    }
    this.lastConflictCount = n;
    this.renderStatus(this.lastPending); // push the badge without waiting for the coarse poll
  }

  private openInbox(): void {
    if (this.engine === null) {
      new Notice("Zync: sync not started.");
      return;
    }
    new ConflictInboxModal(this.app, this.engine).open();
  }

  /** Task 8: open the batched pending-plugin-update modal. */
  private openPendingUpdates(): void {
    const engine = this.engine;
    const runtime = this.runtime;
    if (engine === null) {
      new Notice("Zync: sync not started.");
      return;
    }
    new PendingUpdatesModal(this.app, engine, (id) => {
      if (runtime === null) {
        // No live runtime — the staged bytes are already on disk, so a restart applies them.
        // ALWAYS clear the marker so the entry never sticks forever, then nudge the user to reload.
        engine.clearPluginUpdate(id);
        new Notice(`Zync: could not live-reload ${id}. Restart Obsidian to apply the update.`);
        return;
      }
      // Disable then re-enable to live-reload the plugin with its newly-materialized code.
      void runtime
        .disable(id)
        .then(() => runtime.enable(id))
        .then(() => engine.clearPluginUpdate(id))
        .catch(() => {
          // Degrade gracefully — the staged bytes are already on disk, so a full restart works.
          engine.clearPluginUpdate(id);
          new Notice(`Zync: could not live-reload ${id}. Restart Obsidian to apply the update.`);
        });
    }).open();
  }

  /**
   * Slice 2b: live apply reconciler.
   *
   * Diffs `engine.desiredActivePlugins()` (the managed+enabled set) against `runtime.enabledIds()`
   * (what app.plugins currently has running). Enables anything desired-but-not-running, and disables
   * anything running-but-not-desired IF Zync manages it (never touch a user's local-only plugin).
   *
   * Each call is fire-and-forget (void). Failures in enable/disable are caught inside
   * ObsidianPluginRuntime and degrade silently — the community-plugins.json projection (floor) still
   * ensures the plugin activates after the next Obsidian restart.
   */
  private reconcilePlugins(): void {
    if (!this.engineReady || this.engine === null || this.runtime === null) return;
    const desired = new Set(this.engine.desiredActivePlugins());
    const running = new Set(this.runtime.enabledIds());
    for (const id of desired) {
      if (!running.has(id)) void this.runtime.enable(id);
    }
    for (const id of running) {
      if (!desired.has(id) && this.engine.isManaged(id)) void this.runtime.disable(id);
    }
  }

  // ── settings ───────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<ZyncSettings> | null;
    // Deep-merge syncConfig so newly-added fields (e.g. `plugins`) fall back to their defaults
    // when a user's persisted data.json pre-dates the field — a shallow spread would swallow the
    // nested object and leave the new field undefined.
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      syncConfig: { ...DEFAULT_SETTINGS.syncConfig, ...loaded?.syncConfig },
    };
    if (this.settings.deviceId === "") {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Returns all plugins with a shared opt-in entry. Empty when engine is not yet started. */
  listPluginOptIn(): { id: string; optIn: boolean; isDesktopOnly: boolean }[] {
    if (!this.engineReady || this.engine === null) return [];
    return this.engine.listPluginOptIn();
  }

  /** Opt a plugin in/out of sync. No-op when engine is not yet started. */
  async setPluginOptIn(id: string, optIn: boolean): Promise<void> {
    if (this.engineReady && this.engine !== null) {
      await this.engine.setPluginOptIn(id, optIn);
    }
  }

  // ── Task 9: suppress control + enabled indicator delegates ───────────────

  /** Plugin ids suppressed on this device. Empty when engine is not yet started. */
  listPluginSuppress(): string[] {
    if (!this.engineReady || this.engine === null) return [];
    return this.engine.listPluginSuppress();
  }

  /** Durably suppress/unsuppress a plugin on this device. No-op when engine is not yet started. */
  async setPluginSuppressed(id: string, suppressed: boolean): Promise<void> {
    if (this.engineReady && this.engine !== null) {
      await this.engine.setPluginSuppressed(id, suppressed);
    }
  }

  /** All plugins with a shared enabled entry (shared CRDT state). Empty when not yet started. */
  listPluginEnabled(): { id: string; enabled: boolean }[] {
    if (!this.engineReady || this.engine === null) return [];
    return this.engine.listPluginEnabled();
  }

  // ── Slice 3b: per-plugin settings-sync control ──────────────────────────────

  /** Plugin ids excluded from settings (data.json) sync on this device. Empty when not started. */
  listPluginSettingsSyncOff(): string[] {
    return this.engine?.settingsSyncOff() ?? [];
  }

  /** Enable/disable data.json sync for a specific plugin. No-op when engine is not yet started. */
  async setPluginSettingsSync(id: string, on: boolean): Promise<void> {
    this.engine?.setPluginSettingsSync(id, on);
  }
}

interface InstalledPlugin {
  id: string;
  name: string;
  isDesktopOnly: boolean;
}
function installedCommunityPlugins(app: App): InstalledPlugin[] {
  const pm = (
    app as unknown as {
      plugins?: {
        manifests?: Record<
          string,
          {
            id: string;
            name?: string;
            isDesktopOnly?: boolean;
          }
        >;
      };
    }
  ).plugins;
  const manifests = pm?.manifests ?? {};
  return Object.values(manifests)
    .filter((m) => m.id !== "zync")
    .map((m) => ({ id: m.id, name: m.name ?? m.id, isDesktopOnly: m.isDesktopOnly === true }));
}

class ZyncSettingTab extends PluginSettingTab {
  private readonly plugin: ZyncPlugin;
  /**
   * Ids of plugin rows currently expanded. Held on the tab instance — OUTSIDE
   * display() — because we call this.display() after every change (opt-in,
   * override, expand). Without external state an open row would collapse the
   * instant you flip an override.
   */
  private readonly expandedPluginIds = new Set<string>();

  constructor(app: App, plugin: ZyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Relay URL (WebSocket)")
      .setDesc("e.g. ws://localhost:1234 (the @zync/server relay).")
      .addText((t) =>
        t
          .setPlaceholder("ws://localhost:1234")
          .setValue(this.plugin.settings.serverWs)
          .onChange(async (v) => {
            this.plugin.settings.serverWs = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Blob URL (HTTP)")
      .setDesc("e.g. http://localhost:8080 (the content-addressed blob endpoint).")
      .addText((t) =>
        t
          .setPlaceholder("http://localhost:8080")
          .setValue(this.plugin.settings.serverHttp)
          .onChange(async (v) => {
            this.plugin.settings.serverHttp = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Static token shared with the relay + blob endpoint (per-device tokens come later).")
      .addText((t) => {
        t.setValue(this.plugin.settings.token).onChange(async (v) => {
          this.plugin.settings.token = v.trim();
          await this.plugin.saveSettings();
        });
        t.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("A label for this device.")
      .addText((t) =>
        t.setValue(this.plugin.settings.deviceName).onChange(async (v) => {
          this.plugin.settings.deviceName = v.trim() === "" ? "obsidian-desktop" : v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync themes")
      .setDesc("Sync .obsidian/themes/ across devices. Restart required to apply.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncConfig.themes).onChange(async (v) => {
          this.plugin.settings.syncConfig.themes = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync snippets")
      .setDesc("Sync .obsidian/snippets/ across devices. Restart required to apply.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncConfig.snippets).onChange(async (v) => {
          this.plugin.settings.syncConfig.snippets = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync plugins")
      .setDesc("Sync installed community plugins across devices. Restart required to apply.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncConfig.plugins).onChange(async (v) => {
          this.plugin.settings.syncConfig.plugins = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync plugin settings")
      .setDesc(
        "Sync each synced plugin's data.json (settings) across devices. Restart required to apply.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncConfig["plugin-data"]).onChange(async (v) => {
          this.plugin.settings.syncConfig["plugin-data"] = v;
          await this.plugin.saveSettings();
        }),
      );

    this.renderSyncedPlugins(containerEl);

    new Setting(containerEl)
      .setName("Apply + restart sync")
      .setDesc("Reconnect with the current settings.")
      .addButton((b) =>
        b
          .setButtonText("Restart")
          .setCta()
          .onClick(() => {
            void this.plugin.restart();
            new Notice("Zync: restarting…");
          }),
      );
  }

  /** The "Synced plugins" section: heading, helper, category master-gate, list. */
  private renderSyncedPlugins(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Synced plugins" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Turn on Sync to keep a plugin's code in step on every device. " +
        "Expand a synced plugin for per-device options.",
    });

    const disabled = !this.plugin.settings.syncConfig.plugins;

    // Section master-gate: the "Sync plugins" category toggle governs this whole
    // section, mirroring how a row's Sync toggle governs its overrides.
    if (disabled) {
      const notice = new Setting(containerEl)
        .setName("Plugin sync is off")
        .setDesc("Turn it on to sync any of these plugins.");
      notice.settingEl.addClass("zync-section-notice");
      notice.addButton((b) =>
        b
          .setButtonText("Turn on plugin sync")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.syncConfig.plugins = true;
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    }

    const optedIn = new Set(
      this.plugin
        .listPluginOptIn()
        .filter((p) => p.optIn)
        .map((p) => p.id),
    );
    const suppressed = new Set(this.plugin.listPluginSuppress());
    const settingsOff = new Set(this.plugin.listPluginSettingsSyncOff());

    const list = containerEl.createDiv({ cls: "zync-plugin-list" });
    if (disabled) list.addClass("zync-disabled");
    for (const p of installedCommunityPlugins(this.app)) {
      this.renderPluginRow(list, p, optedIn, suppressed, settingsOff, disabled);
    }
  }

  /** One plugin's row: a single Sync toggle + chevron-expand of its overrides. */
  private renderPluginRow(
    containerEl: HTMLElement,
    p: InstalledPlugin,
    optedIn: ReadonlySet<string>,
    suppressed: ReadonlySet<string>,
    settingsOff: ReadonlySet<string>,
    disabled: boolean,
  ): void {
    const synced = optedIn.has(p.id);
    const state = overrideState(p.id, suppressed, settingsOff);
    const expanded = this.expandedPluginIds.has(p.id);

    const toggleExpand = (): void => {
      if (disabled || !synced) return;
      if (this.expandedPluginIds.has(p.id)) this.expandedPluginIds.delete(p.id);
      else this.expandedPluginIds.add(p.id);
      this.display();
    };

    const row = new Setting(containerEl).setName(p.name);

    // Description line: deviation chips + optional desktop-only note; empty when
    // synced at defaults (the calm common case).
    // Only surface deviation chips for actually-synced plugins — an opted-out
    // plugin isn't managed by Zync, and its chip would be unreachable (chevron
    // hidden, sub-panel not rendered), promising state the row can't clear.
    if (synced && state.suppressed)
      row.descEl.createSpan({ cls: "zync-override-chip", text: "off here" });
    if (synced && state.settingsLocal)
      row.descEl.createSpan({ cls: "zync-override-chip", text: "local settings" });
    if (p.isDesktopOnly) row.descEl.createSpan({ cls: "zync-note", text: "Desktop only" });

    // Chevron (left of the toggle): reveals per-device options. Hidden until
    // synced (kept in the layout to avoid a column shift); tinted when deviated.
    row.addExtraButton((b) => {
      b.setIcon(expanded ? "chevron-down" : "chevron-right")
        .setTooltip("Per-device options")
        .onClick(toggleExpand);
      b.extraSettingsEl.addClass("zync-chevron");
      if (!synced) b.extraSettingsEl.addClass("zync-hidden");
      if (state.deviated) b.extraSettingsEl.addClass("zync-deviated");
    });

    // Primary Sync toggle — the opt-in / master gate for this plugin.
    row.addToggle((t) =>
      t
        .setValue(synced)
        .setTooltip("Sync this plugin across devices")
        .setDisabled(disabled)
        .onChange(async (v) => {
          await this.plugin.setPluginOptIn(p.id, v);
          this.display();
        }),
    );

    // The name/description area is also a tap target for expand (synced only),
    // excluding the controls so flipping the toggle never expands the row.
    if (synced && !disabled) {
      row.infoEl.addClass("zync-clickable");
      row.infoEl.addEventListener("click", toggleExpand);
    }

    // Expanded sub-panel: the two overrides + a conditional reset.
    if (synced && expanded && !disabled) {
      const panel = containerEl.createDiv({ cls: "zync-subpanel" });

      new Setting(panel)
        .setName("Run on this device")
        .setDesc(
          "Keep this plugin synced everywhere, but turned off on this device. " +
            "Your other devices aren't affected.",
        )
        .addToggle((t) =>
          t.setValue(!state.suppressed).onChange(async (v) => {
            await this.plugin.setPluginSuppressed(p.id, !v);
            this.display();
          }),
        );

      new Setting(panel)
        .setName("Sync settings")
        .setDesc("Also sync this plugin's settings. Turn off to let each device keep its own.")
        .addToggle((t) =>
          t.setValue(!state.settingsLocal).onChange(async (v) => {
            await this.plugin.setPluginSettingsSync(p.id, v);
            this.display();
          }),
        );

      if (state.deviated) {
        new Setting(panel).addButton((b) =>
          b.setButtonText("Reset to defaults").onClick(async () => {
            await this.plugin.setPluginSuppressed(p.id, false);
            await this.plugin.setPluginSettingsSync(p.id, true);
            this.display();
          }),
        );
      }
    }
  }
}
