# Zync

**Self-hosted, real-time Obsidian sync — CRDT for prose, file-sync for everything else, plaintext on your own server.**

> **NOT YET INSTALLABLE.** The production engine is under active construction. What exists today is a validated binding gate (Phase 0a) and detailed plans for the full system. See Status below.

---

## What it is

Zync is a custom Obsidian sync plugin backed by a lightweight server you run yourself. It fills a gap that no existing tool covers: **real-time while open + flat plaintext on your own server + config sync**, all in one.

Each file type is routed to the right channel:

| What | How |
|---|---|
| `.md` / `.txt` — prose | CRDT (`Y.Text` via Yjs); live editor binding when open; merges concurrently, no conflict markers |
| `.canvas`, `.json`, structured text | File-sync (content-addressed, LWW) |
| Binaries (images, PDFs, …) | File-sync (content-addressed, lazy fetch on mobile) |
| `.obsidian/` config + plugins | Atomic LWW bundles, version-gated, independent channel |

The server is a plain Node process. Your notes sit on disk as flat `.md` files — readable by any tool, including an AI agent.

---

## Why this exists

The target is the intersection none of the alternatives reach:

- **Self-Hosted LiveSync** — near-impenetrable docs, and stores chunked DB docs (not flat plaintext).
- **Syncthing** — robust and plaintext, but a separate app to babysit on Android; not real-time.
- **Obsidian Sync (paid)** — encrypted at rest; no AI access.
- **WebDAV / Remotely Save** — schedule-based, weak conflict handling.

Zync is real-time while Obsidian is open, stores flat plaintext on the server, and handles plugin/config sync through a separate channel that does not block on the CRDT bet.

---

## Status

**Design + Phase 0a binding gate: VALIDATED.**

The single highest project risk — whether `y-codemirror.next` can be a well-behaved live collaborative binding inside Obsidian on **desktop and real Android Gboard IME** (including concurrent swipe-typing on the same paragraph) — has been manually validated on real hardware and **passed** (2026-06-11).

The production engine (hexagonal core, three-way merge bridge, headless test harness, custom IDB provider, auth, blob sync, config sync) is **under construction**, planned and built phase by phase.

**Do not try to install or use this yet.**

What currently exists:
- `packages/plugin/` — a throwaway binding spike (Phase 0a). Proves the CM6↔Yjs binding works; not the production plugin.
- `packages/server/` — a minimal Hocuspocus relay with static-token auth. Not production-ready.

---

## Architecture (in brief)

```
         ┌──────────────────────────────────┐
         │ VPS (public TLS or private net)  │
         │   Zync server (Node)             │
         │   • CRDT relay (Hocuspocus)      │
         │   • file-sync endpoint           │
         │   • per-device auth              │
         │   • one-way plaintext projection │
         └────────────┬─────────────────────┘
              ws/yjs  │  https file-sync
      ┌───────────────▼──────────┐
      │ Obsidian plugin          │
      │   CRDT bridge (prose)    │
      │   file-sync (blobs)      │
      │   config sync (LWW)      │
      │   status + conflict inbox│
      └──────────────────────────┘
```

**Auth is transport-agnostic.** The server can be exposed as a public HTTPS endpoint (Traefik + Let's Encrypt via your reverse-proxy stack) and/or kept on a private network (e.g. Tailscale/WireGuard) — a deployment choice. Per-device revocable tokens are verified in `onAuthenticate` regardless of how the server is reached.

**Hexagonal architecture.** A pure `@zync/core` package holds all sync domain logic (classification, three-way merge, echo suppression, authority FSM, bootstrap). It imports nothing from Obsidian, Yjs, or Node. Adapters — Obsidian vault, Node filesystem, Hocuspocus transport, IndexedDB store — depend on the core's ports, not the other way around.

---

## Repo layout

```
packages/
  core/            @zync/core      pure domain + ports            [planned — Phase 0b-1]
  crdt-yjs/        @zync/crdt-yjs  Yjs adapter + CM6 binding      [planned — Phase 0b-2]
  plugin/          @zync/plugin    Obsidian plugin (spike only)   [exists — throwaway]
  server/          @zync/server    relay + file endpoint          [exists — minimal spike]
  headless-client/ @zync/headless  Node FS adapter + control API  [planned — Phase 0b-3]
  harness/         @zync/harness   Docker e2e test harness        [planned — Phase 0b-3]
```

---

## Installation (future)

Once a release exists, the plugin will be installable via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

```
BRAT → Add beta plugin → https://github.com/<owner>/zync
```

Server deployment will require Docker (a `Dockerfile` is provided for `packages/server`).

**There are no releases yet. This is not installable.**

---

## Development

```bash
pnpm install
pnpm server        # start the relay (localhost:1234)
pnpm build:plugin  # build packages/plugin/main.js
pnpm verify        # typecheck + lint + format:check + test
```

Requires Node 22 and pnpm 10.

---

## License

GPL-3.0. See [LICENSE](LICENSE).
