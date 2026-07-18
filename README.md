# Zync

**Self-hosted, real-time Obsidian sync — CRDT for prose, file-sync for everything else, plaintext on your own server.**

> **Self-hosted, and installable now — `v0.2.0`, via [BRAT](https://github.com/TfTHacker/obsidian42-brat).** The engine, plugin, and server are built and harness-gated. It's an early release: not yet validated on real Android or very large vaults. See [Status](#status).

---

## What it is

Zync is a custom Obsidian sync plugin backed by a lightweight server you run yourself. It targets one specific intersection: **real-time while open + flat plaintext on your own server + config sync**, all in one.

Each file type is routed to the right channel:

| What | How |
|---|---|
| `.md` / `.txt` — prose | CRDT (`Y.Text` via Yjs); live editor binding when open; merges concurrently, no conflict markers |
| `.canvas`, `.json`, structured text | content-addressed blob sync (hash-on-write) |
| Binaries (images, PDFs, …) | content-addressed blob sync (lazy or eager fetch) |
| `.obsidian/` config + plugins | atomic LWW bundles on an independent channel — themes, snippets, plugin code + data |

The server is a plain Node process. Your notes sit on disk as flat `.md` files — readable by any tool, including an AI agent.

---

## Why this exists

I built Zync mainly to simplify my own setup: one real-time channel for the notes I'm actively editing, flat plaintext on a server I already run, and config/plugin sync in the same tool. The existing options are all good at what they do — each just sits slightly off from that particular intersection:

- **[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)** — battle-tested and fully self-hosted, but it stores the vault as chunked CouchDB documents rather than flat `.md` files, and the initial setup has a real learning curve.
- **[Syncthing](https://syncthing.net/)** — rock-solid and keeps plaintext on disk, but it's a separate app to run (a little fiddly on Android) and syncs on file change rather than live while you type.
- **[Obsidian Sync](https://obsidian.md/sync)** — polished and the easiest to get going, but it's a paid hosted service and encrypted at rest, so notes aren't sitting in plaintext for other tools (like a local AI agent) to read.
- **[Remotely Save](https://github.com/remotely-save/remotely-save) / WebDAV** — flexible and works with storage you already have, but it's schedule- or trigger-based rather than real-time.

I also use **git** with this vault — but for version history and backups, not for syncing. Git handles "let me roll back to last week"; Zync handles the live, cross-device sync. They complement each other rather than overlap.

The niche Zync aims for: real-time while Obsidian is open, flat plaintext on your own server, and plugin/config sync through a separate channel that doesn't block on the CRDT bet — all in one tool.

---

## Who this is for

Zync assumes you already run (or are happy to run) your own server, and are comfortable with a technical initial setup — Docker, a reverse proxy or private network, and per-device tokens. Once it's running it stays out of the way, but the first-time wiring is hands-on.

If you'd rather not host anything, [Obsidian Sync](https://obsidian.md/sync) is the easier path. Zync is for people who want their notes as plaintext on infrastructure they control.

---

## Status

**Functionally complete and installable today — current release `v0.2.0`.**

The engine, the Obsidian plugin, and the production server are all built, and the core sync contract is gated by a real end-to-end test harness. What's left before a `1.0` is real-world validation, not more features.

**Built and working:**

- **Prose CRDT sync** — `.md`/`.txt` merge concurrently with no conflict markers; live editor binding while a note is open.
- **Attachments & structured files** — content-addressed blob sync (hash-on-write, lazy or eager fetch).
- **Config/plugin sync** — themes, snippets, plugin code, and plugin-data settings over an independent channel.
- **Rename, delete & conflicts** — folder + file rename, delete propagation, a conflict inbox (keep-mine / keep-theirs, bulk), and startup + reconnect self-heal.
- **Obsidian plugin** — full settings UI, a status bar (connection · pending · files · conflicts · updates), commands, and conflict/pending modals; `isDesktopOnly: false`.
- **Production server** — content-blind Hocuspocus relay + blob endpoint + snapshot persistence, a file-backed per-device token registry, and an admin console for minting/revoking device tokens. Deploy runbook in [`deploy/`](deploy/README.md).

**Validated by the harness:** a two-network `docker compose` harness exercises end-to-end sync — offline/partition/reconnect, crash + restart, rename, concurrent-create, blobs, conflict artifacts — against a **real WebSocket relay and a real filesystem** (`pnpm harness`). It surfaced (and fixed) a class of real-relay data-loss/convergence bugs that in-process tests had hidden. Scale check: a second device adopts a real ~1,260-note vault with **zero per-note attaches** (content-hash stamps detect already-synced state from the index alone).

**Caveats — before you rely on it:**

- **Early release line (`v0.2.0`)** — installable via BRAT today, but young and moving fast (building from source works too; see [Installation](#installation)).
- The core collaborative binding (`y-codemirror.next`) was verified live on **desktop and real Android Gboard IME**, including concurrent swipe-typing on the same paragraph — but the full production plugin hasn't been exercised on a real Android device end-to-end yet, and lacks a background-resume reconnect hook.
- Not yet profiled on a very large, attachment-heavy vault; first-sync/blob-bootstrap cost is the main open unknown.

---

## Architecture (in brief)

```
         ┌──────────────────────────────────┐
         │ Server (public TLS or private net)│
         │   • CRDT relay (Hocuspocus)       │  content-blind: relays/persists
         │   • blob endpoint (hash-on-write) │  opaque CRDT + blobs, never reads notes
         │   • snapshot persistence          │
         │   • per-device auth               │
         └────────────┬─────────────────────┘
              ws/yjs  │  https blobs
      ┌───────────────▼──────────┐
      │ Device (plugin / headless)│
      │   CRDT bridge (prose)     │
      │   blob sync               │
      │   status + conflict inbox │
      └──────────────────────────┘
```

**Hexagonal architecture.** A pure `@zync/core` holds all sync domain logic and imports nothing from Obsidian, Yjs, or Node — a lint-enforced firewall. Adapters (Obsidian vault, Node filesystem, Yjs/Hocuspocus transport, S3/MinIO blobs, IndexedDB) depend on the core's ports, not the other way around. **The same `SyncEngine` runs in the plugin and in headless test devices** — that identity is what powers the Docker harness.

**Content-blind server.** The relay relays and persists opaque CRDT updates and content-addressed blobs; it has no note-reading code path. (End-to-end encryption can later land at the transport seam without an engine rewrite.)

**Auth is per-device tokens.** A file-backed token registry — managed from a small admin console — gates every relay and blob connection; revoking one device doesn't disturb the others. The server can sit behind a TLS reverse proxy or on a private overlay network (the reference deploy uses Tailscale) — a deployment choice, since tokens are verified on connect regardless of how the server is reached.

---

## Repo layout

```
packages/
  core/            @zync/core            pure sync domain + ports (no infra imports)
  crdt-yjs/        @zync/crdt-yjs        Yjs adapters + CM6 editor binding (subpath) + Hocuspocus transport
  vault-obsidian/  @zync/vault-obsidian  Obsidian adapters — vault, config, editor binding, plugin runtime
  store-idb/       @zync/store-idb       IndexedDB persistence for docs + engine state (browser/plugin)
  blob-http/       @zync/blob-http       HTTP client for the content-addressed blob store
  server/          @zync/server          content-blind relay + blob endpoint + snapshots
  headless-client/ @zync/headless-client Node FS/HTTP adapters + daemon + control API
  harness/         @zync/harness         Docker end-to-end test harness (compose + scenarios)
  plugin/          @zync/plugin          Obsidian plugin — settings UI, status bar, commands, conflict/pending modals
```

---

## Development

```bash
pnpm install
pnpm verify        # typecheck + lint + format:check + unit tests (no Docker)
pnpm server        # start the relay locally
pnpm harness       # full end-to-end Docker harness (builds, runs scenarios, tears down)
pnpm harness:scale # scale feasibility suite (needs a local vault snapshot)
```

Requires Node 22, pnpm 10, and Docker (for the harness).

---

## Installation

Two parts: install the plugin (per device) and run the server (once).

### Plugin

Easiest is [BRAT](https://github.com/TfTHacker/obsidian42-brat) — **Add beta plugin → `https://github.com/KazeFreeze/zync`**, which tracks the latest release (currently **v0.2.0**).

Or build from source:

```bash
pnpm install
pnpm build:plugin        # emits packages/plugin/{main.js, manifest.json, styles.css}
```

Copy those three files into `<vault>/.obsidian/plugins/zync/` and enable **Zync** under Community Plugins.

Either way, open the plugin settings and paste your server's relay + blob URLs and a device token from the admin console.

### Server

Run the content-blind relay + blob endpoint + admin console yourself. The reference deployment is a single-node **Dokploy** host over **Tailscale**, with attachment blobs on **Backblaze B2** — full runbook in [`deploy/README.md`](deploy/README.md) (compose file: [`deploy/dokploy-compose.yml`](deploy/dokploy-compose.yml)). For local development, `pnpm server` starts the relay on `:1234`. Transport security is whatever you put in front of it (Tailscale/WireGuard in the reference deploy, or a TLS reverse proxy); per-device tokens are minted and revoked from the admin console.

---

## License

GPL-3.0. See [LICENSE](LICENSE).
