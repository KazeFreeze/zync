import { Plugin, PluginSettingTab, Setting, Notice, type App } from "obsidian";
import {
  SyncEngine,
  isActionableConflict,
  type ClockPort,
  type DeviceId,
  type IdentityPort,
} from "@zync/core";
import { ConflictInboxModal } from "./conflict-inbox-modal.js";
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
import { ObsidianVaultPort, ObsidianEditorBinding } from "@zync/vault-obsidian";
import { PortProfiler } from "./profiling.js";

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
}

const DEFAULT_SETTINGS: ZyncSettings = {
  serverWs: "",
  serverHttp: "",
  token: "",
  deviceName: "obsidian-desktop",
  deviceId: "",
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

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.statusBar = this.addStatusBarItem();
    this.renderStatus(0);
    if (this.statusBar !== null) {
      this.statusBar.style.cursor = "pointer";
      this.statusBar.addEventListener("click", () => this.openInbox());
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
      id: "zync-restart",
      name: "Zync: restart sync",
      callback: () => {
        void this.restart();
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

      const engine = new SyncEngine(
        { vault: this.vault, crdt, transport, blobs, docStore, clock, identity, engineState },
        // blobPolicy "eager": a desktop device materializes synced blobs to disk (parity with the
        // headless peer's default). Blobs-at-scale + lazy mobile fetch are M2.
        { configDir: CONFIG_DIR, maxProseBytes: MAX_PROSE_BYTES, blobPolicy: "eager" },
      );
      this.engine = engine;

      this.unsubs.push(
        transport.onStatus((s) => {
          this.connText = s;
          void this.refreshStatus();
        }),
      );

      await engine.start();
      this.engineReady = true; // blobProgress()/inbox are now valid to read from renderStatus

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
    this.statusBar?.setText(
      `Zync: ${this.connText}${pending > 0 ? ` · ${String(pending)} pending` : ""}${files}${conf}`,
    );
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

  // ── settings ───────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<ZyncSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...loaded };
    if (this.settings.deviceId === "") {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class ZyncSettingTab extends PluginSettingTab {
  private readonly plugin: ZyncPlugin;

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
}
