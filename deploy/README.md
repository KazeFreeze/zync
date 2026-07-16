# Zync server — production deployment runbook

Deploys the Zync sync server (`@zync/server`: Hocuspocus relay + blob HTTP endpoint + admin console) to a single-node **Dokploy** host, **Tailscale-only**, with blobs on **Backblaze B2**. Design spec: `docs/superpowers/specs/2026-07-15-zync-prod-deployment-design.md`.

## What gets deployed

One container (`zync-server`) exposing three ports, each bound to the host's **tailnet IP** only (never public):

| Port | Service | Reached at |
|------|---------|-----------|
| 1234 | relay (WS) | desktop `ws://<tailnet-ip>:1234`; all devices via Serve `wss://<node>.ts.net:8443` |
| 8080 | blob (HTTP) | desktop `http://<tailnet-ip>:8080`; all devices via Serve `https://<node>.ts.net:10000` |
| 9090 | admin (HTTP) | operator browser, `http://<tailnet-ip>:9090` (tailnet only) |

On-box state lives in two volumes: `zync-snapshots` → `/data/snapshots` (CRDT state) and `zync-config` → `/data/config/tokens.json` (device-token registry). Blob bytes live off-box on B2. Transport is encrypted by WireGuard (Tailscale); auth is per-device tokens; the admin console has its own strong token.

## Prerequisites

- Dokploy running on the host; Tailscale up on the host (note its tailnet IP, e.g. `100.81.186.62`, and MagicDNS `.ts.net` name).
- The `KazeFreeze/zync` repo reachable by the Dokploy GitHub App (`dokploy-bernardtapiru`), with `deploy/dokploy-compose.yml` present on the deployed branch (`main`).
- A Backblaze B2 account.

## Environment variables (set in Dokploy → the compose's Environment)

| Var | Value | Notes |
|-----|-------|-------|
| `TAILSCALE_BIND_IP` | the host's tailnet IP | binds all 3 ports to the tailnet only |
| `ZYNC_ADMIN_USER` | e.g. `admin` | admin console username (HTTP Basic auth) |
| `ZYNC_ADMIN_PASSWORD` | `openssl rand -hex 24` | admin console password; gates the console |
| `ZYNC_S3_ENDPOINT` | `https://s3.<region>.backblazeb2.com` | B2 S3-compatible endpoint |
| `ZYNC_S3_REGION` | e.g. `us-west-004` | B2 region |
| `ZYNC_S3_BUCKET` | `zync-blobs` | dedicated bucket |
| `ZYNC_S3_ACCESS_KEY` | B2 application keyID | scoped to `zync-blobs` |
| `ZYNC_S3_SECRET_KEY` | B2 application key | |

`ZYNC_PORT`/`ZYNC_BLOB_PORT`/`ZYNC_ADMIN_PORT`/`ZYNC_SNAPSHOT_DIR`/`ZYNC_TOKENS_FILE` are set in the compose. **Do not set `ZYNC_TOKEN`** in production — with `ZYNC_TOKENS_FILE` present the server runs in per-device **file mode** and ignores it. (Startup is fail-closed: an empty `ZYNC_ADMIN_PASSWORD`, or single-token mode with an empty/missing `ZYNC_TOKEN`, aborts with a clear error rather than running open.)

## Runbook

### 1. Backblaze B2 (console)
Create a **bucket** `zync-blobs` (private) and an **application key** scoped to just that bucket. Record the endpoint (`s3.<region>.backblazeb2.com`), region, keyID, and secret.

### 2. Retire the old LiveSync stack (frees Tailscale Serve port 8443)
Stop + delete the existing `my-obsidian-livesync` CouchDB Dokploy compose (keep its GitHub repo). This releases Serve port **8443** for Zync's relay. Your vault content is safe in git — nothing to migrate off the server.

### 3. Create the Dokploy project + compose
- New project `zync` → add a **Compose** service, source **GitHub** `KazeFreeze/zync`, branch `main`, compose path `deploy/dokploy-compose.yml`.
- Set the Environment variables from the table above.
- Deploy.

### 4. Verify the deploy (from a device on the tailnet)
- Relay up: `nc -vz <tailnet-ip> 1234`
- Blob auth on: `curl -s -o /dev/null -w "%{http_code}\n" http://<tailnet-ip>:8080/blob/$(printf '0%.0s' {1..64})` → **401**
- Admin loads: open `http://<tailnet-ip>:9090` → the browser prompts for the admin username/password; after logging in the (empty) device list + status appear.

### 5. Tailscale Serve — HTTPS for mobile (run on the host)
Obsidian Mobile rejects plain HTTP/WS, so wrap the two client-facing services in HTTPS on the `.ts.net` name (real Let's Encrypt cert). Requires MagicDNS + HTTPS certs enabled on the tailnet (already on from LiveSync).
```
tailscale serve --bg --https=8443  http://127.0.0.1:1234   # relay → wss://<node>.ts.net:8443
tailscale serve --bg --https=10000 http://127.0.0.1:8080   # blob  → https://<node>.ts.net:10000
```
Verify from a tailnet device: `curl https://<node>.ts.net:10000/blob/$(printf '0%.0s' {1..64})` → **401**, and a `wss://<node>.ts.net:8443` WebSocket handshake succeeds.

### 6. Cutover — establish the first master (your PC)
1. In the admin console (`http://<tailnet-ip>:9090`), **Add device** `pc-home` → copy the token (shown once).
2. On the PC, start Zync on a **fresh LifeOS checkout at git HEAD** (not your current working vault — that leaves the old conflict backlog behind).
3. In the plugin settings, point at `wss://<node>.ts.net:8443` (relay) + `https://<node>.ts.net:10000` (blob) and paste the `pc-home` token.
4. Let it reach **fully synced / 0 pending**. The first attachment push to B2 is heavy and one-time.

### 7. Add the other devices (clean vaults)
For each device (phone, laptop, …): admin console → Add device → copy its token → configure the plugin on a **clean/empty** vault with the two HTTPS endpoints + that token. It pulls everything down. Only the PC has content at bootstrap, so there's no split-brain.

### 8. Backups
Wire Dokploy volume backups for **both** `zync-config` (tiny/precious — the token registry) and `zync-snapshots` to a B2/R2 destination.

## Operating the server

- **Add / revoke a device token:** use the admin console (`http://<tailnet-ip>:9090`). Add mints a token (shown once); Revoke deletes it — the registry hot-reloads, so that device can no longer connect while the others are unaffected. No redeploy needed.
- **Reset server sync state** (e.g. to re-establish a fresh master): remove the `zync-snapshots` volume and redeploy — device tokens survive because they're on the separate `zync-config` volume.
- **Logs / restart / redeploy / status:** all via the Dokploy UI. The admin console's status panel shows uptime, device count, blob-store reachability, and snapshot count.
