# Zync

**Self-hosted, real-time Obsidian sync — CRDT for prose, file-sync for everything else, plaintext on your own server.**

> **NOT YET INSTALLABLE.** The sync engine is built and validated end-to-end; the production Obsidian plugin (Phase 1) is the next step. See Status.

---

## What it is

Zync is a custom Obsidian sync plugin backed by a lightweight server you run yourself. It fills a gap no existing tool covers: **real-time while open + flat plaintext on your own server + config sync**, all in one.

Each file type is routed to the right channel:

| What | How |
|---|---|
| `.md` / `.txt` — prose | CRDT (`Y.Text` via Yjs); live editor binding when open; merges concurrently, no conflict markers |
| `.canvas`, `.json`, structured text | content-addressed blob sync (hash-on-write) |
| Binaries (images, PDFs, …) | content-addressed blob sync (lazy or eager fetch) |
| `.obsidian/` config + plugins | atomic LWW bundles, independent channel (Phase 2) |

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

**Phase 0a (binding gate) and Phase 0b (engine + server + test harness): COMPLETE and VALIDATED.**

- **Phase 0a — the highest project risk — PASSED on real hardware (2026-06-11):** `y-codemirror.next` is a well-behaved live collaborative binding inside Obsidian on **desktop and real Android Gboard IME**, including concurrent swipe-typing on the same paragraph.
- **Phase 0b — the sync engine, server, and a Docker test harness are built and tested.** A pure hexagonal `@zync/core` engine (classification, three-way merge, echo suppression, authority FSM, bootstrap, lazy-attach, conflict inbox, blob sync) runs identically in unit tests and in headless Node "device" containers. A two-network `docker compose` harness exercises end-to-end sync — offline/partition/reconnect, crash + restart, rename, concurrent-create, blobs, conflict artifacts — against a **real WebSocket relay and a real filesystem**, with one command (`pnpm harness`).
- **The harness proved its worth:** it surfaced a class of real-relay/real-filesystem data-loss and convergence bugs that an in-process test suite alone had hidden — every one was fixed and re-validated live. The Phase-0 question, *"is the file↔CRDT bridge corruption-proof?"*, now answers **yes against a real relay**, not just against test doubles.
- **Scale feasibility: GO.** Against a real ~1,260-note vault, an identical second device adopts the whole vault with **zero per-note attaches** (content-hash stamps let it detect already-synced state from the index alone), the long-term index-doc scaling bound is ~300 KB, and memory stays modest with no OOM or non-convergence.

**Still not installable:** the current `packages/plugin/` is a throwaway Phase-0a binding spike. The production Obsidian plugin is **Phase 1** (built from the official `obsidian-sample-plugin` template), with a custom IndexedDB provider, real per-device tokens, and the on-device editor wiring. Config/plugin sync is **Phase 2**.

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

**Auth is transport-agnostic.** The server can be a public HTTPS endpoint (e.g. via a reverse proxy) and/or on a private network — a deployment choice. Per-device tokens are verified on connect regardless of how it's reached.

---

## Repo layout

```
packages/
  core/            @zync/core            pure domain + ports (no infra imports)
  crdt-yjs/        @zync/crdt-yjs        Yjs adapter + CM6 binding + Hocuspocus transport
  server/          @zync/server          content-blind relay + blob endpoint + snapshots
  headless-client/ @zync/headless-client Node FS/HTTP adapters + daemon + control API
  harness/         @zync/harness         Docker end-to-end test harness (compose + scenarios)
  plugin/          @zync/plugin          Obsidian plugin — throwaway Phase-0a spike (real one = Phase 1)
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

## Installation (future)

Once the Phase-1 plugin has a release, it will be installable via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

```
BRAT → Add beta plugin → https://github.com/KazeFreeze/zync
```

The server runs via Docker. **There are no releases yet — this is not installable.**

---

## License

GPL-3.0. See [LICENSE](LICENSE).
