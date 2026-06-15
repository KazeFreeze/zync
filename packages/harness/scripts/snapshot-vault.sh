#!/usr/bin/env bash
#
# snapshot-vault.sh — derive the @scale fixture from the user's REAL Obsidian vault
# (Phase 0b-3, Task 6, Deliverable 1).
#
# PRIVACY: the produced fixture is PERSONAL note content. It lands ONLY under
# packages/harness/fixtures/lifeos* (gitignored) and is NEVER committed/pushed.
# This script prints aggregate counts/sizes ONLY — never note titles or content.
#
# SOURCE OF TRUTH = origin/main, NOT the messy working tree. The vault working
# copy has uncommitted edits, a transient `.trash`, and sync-plugin state;
# origin/main is the canonical clean committed state (~1252 .md). We therefore
# materialise the fixture from the COMMITTED tree of origin/main via `git archive`
# (reproducible; no working-tree cruft; no network/auth needed for the archive
# itself), then strip a small set of sync/config cruft.
#
#   ZYNC_VAULT_SRC      path to the vault git repo   (default ~/Documents/LifeOS)
#   ZYNC_SCALE_PROSE_ONLY=1
#                       exclude LARGE binary attachments (keep .md/.canvas/.base
#                       and small images) so 3× device tmpfs vaults don't strain
#                       memory. DEFAULT: include attachments.
#   ZYNC_SCALE_PROSE_MAX_BYTES
#                       size threshold for "large" in prose-only mode
#                       (default 262144 = 256 KiB).
#
# Produces three sibling, gitignored dirs under packages/harness/fixtures/:
#   lifeos/                clean committed tree of origin/main (minus cruft)
#   lifeos-identical/      byte-for-byte copy of lifeos/
#   lifeos-divergent-10/   copy with EXACTLY 10 .md files modified (marker appended)
#                          + a manifest (divergent-manifest.txt) listing those 10,
#                          which the @scale scenario reads to assert exactly-10.
#
set -euo pipefail

# ── locate paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$HARNESS_ROOT/fixtures"
LIFEOS_DIR="$FIXTURES_DIR/lifeos"
IDENTICAL_DIR="$FIXTURES_DIR/lifeos-identical"
DIVERGENT_DIR="$FIXTURES_DIR/lifeos-divergent-10"
# Manifest lives OUTSIDE the loaded vault dir (a sibling) so it never pollutes
# device-c's /fs/tree as a spurious extra note. Still gitignored (lifeos-*).
MANIFEST="$FIXTURES_DIR/lifeos-divergent-10-manifest.txt"

VAULT_SRC="${ZYNC_VAULT_SRC:-$HOME/Documents/LifeOS}"
PROSE_ONLY="${ZYNC_SCALE_PROSE_ONLY:-0}"
PROSE_MAX_BYTES="${ZYNC_SCALE_PROSE_MAX_BYTES:-262144}"
REF="origin/main"

log() { printf '[snapshot-vault] %s\n' "$*"; }

# ── preconditions ───────────────────────────────────────────────────────────
if [ ! -d "$VAULT_SRC/.git" ]; then
  log "ERROR: \$ZYNC_VAULT_SRC ($VAULT_SRC) is not a git repository."
  log "       Set ZYNC_VAULT_SRC to the vault's git working dir and retry."
  exit 1
fi

# ── 1. best-effort refresh origin/main (no auth in this env ⇒ continue) ──────
log "vault: $VAULT_SRC  ref: $REF  prose-only: $PROSE_ONLY"
if git -C "$VAULT_SRC" fetch --quiet origin main 2>/dev/null; then
  log "fetched latest origin/main."
else
  log "NOTE: 'git fetch origin main' failed (no auth from this env) — using the"
  log "      already-fetched origin/main ref. The archive below needs no network."
fi

if ! git -C "$VAULT_SRC" rev-parse --verify --quiet "$REF" >/dev/null; then
  log "ERROR: ref '$REF' not found in $VAULT_SRC. Cannot snapshot."
  exit 1
fi
REF_SHA="$(git -C "$VAULT_SRC" rev-parse --short "$REF")"
log "snapshotting committed tree at $REF ($REF_SHA)."

# ── 2. extract the COMMITTED tree (no .git, no uncommitted edits) ────────────
rm -rf "$LIFEOS_DIR" "$IDENTICAL_DIR" "$DIVERGENT_DIR"
mkdir -p "$LIFEOS_DIR"
# `git archive | tar -x` materialises ONLY tracked content of the ref — clean +
# reproducible, and immune to the dirty working tree / .trash / .git directory.
git -C "$VAULT_SRC" archive "$REF" | tar -x -C "$LIFEOS_DIR"

# ── 3. exclusions on the extracted tree (privacy + correctness) ──────────────
# Strip sync-plugin / workspace / conflicting-sync-tool cruft. The engine routes
# .obsidian → config/excluded anyway (harmless to sync), but a clean fixture keeps
# the device tmpfs vaults lean and the metrics honest.
log "applying exclusions…"
# workspace + mobile + their sync-conflict siblings (Obsidian local UI state)
find "$LIFEOS_DIR" -type f \( \
  -name 'workspace.json' -o \
  -name 'workspace-mobile.json' -o \
  -name 'workspace*.sync-conflict-*.json' \
\) -delete 2>/dev/null || true
# conflicting sync-plugin dirs + markers
rm -rf \
  "$LIFEOS_DIR/.obsidian/plugins/obsidian-livesync" \
  "$LIFEOS_DIR/.obsidian/zync" \
  "$LIFEOS_DIR/.trash" 2>/dev/null || true
find "$LIFEOS_DIR" -type d -name '.stfolder' -exec rm -rf {} + 2>/dev/null || true
find "$LIFEOS_DIR" -type f \( -name '.stfolder' -o -name '.syncthing*' \) -delete 2>/dev/null || true

# ── 3b. prose-only mode: drop LARGE binary attachments ───────────────────────
# Keep .md/.markdown/.txt (notes), .canvas/.base/.json (structured), and small
# images; drop anything else over the threshold so 3× tmpfs vaults stay light.
if [ "$PROSE_ONLY" = "1" ]; then
  log "prose-only: dropping non-prose/structured files larger than ${PROSE_MAX_BYTES} bytes…"
  # shellcheck disable=SC2016
  find "$LIFEOS_DIR" -type f -size +"${PROSE_MAX_BYTES}"c \
    ! -iname '*.md' ! -iname '*.markdown' ! -iname '*.txt' \
    ! -iname '*.canvas' ! -iname '*.base' ! -iname '*.json' \
    -delete 2>/dev/null || true
  # Also drop the multi-MB plugin binaries regardless of the small-image keep-list.
  find "$LIFEOS_DIR" -type f -size +"${PROSE_MAX_BYTES}"c -iname '*.bin' -delete 2>/dev/null || true
fi

# Drop now-empty directories left by the exclusions (keep the tree tidy).
find "$LIFEOS_DIR" -type d -empty -delete 2>/dev/null || true

# ── 4. variants ──────────────────────────────────────────────────────────────
# 4a. identical: byte-for-byte copy.
log "creating lifeos-identical/ (byte copy)…"
cp -a "$LIFEOS_DIR" "$IDENTICAL_DIR"

# 4b. divergent-10: copy, then modify EXACTLY 10 .md files (deterministic pick:
# the lexicographically-first 10 .md paths) by appending a marker. Record which 10
# in a manifest the scenario reads. Determinism ⇒ the scenario asserts exactly-10.
log "creating lifeos-divergent-10/ (10 .md files modified)…"
cp -a "$LIFEOS_DIR" "$DIVERGENT_DIR"

MARKER=$'\n\n<!-- ZYNC-SCALE-DIVERGENT-MARKER do-not-edit -->\n'
: > "$MANIFEST"
n=0
# Stable order: NUL-safe sort of relative .md paths. Modify the first 10.
while IFS= read -r -d '' rel; do
  [ "$n" -ge 10 ] && break
  printf '%s' "$MARKER" >> "$DIVERGENT_DIR/$rel"
  printf '%s\n' "$rel" >> "$MANIFEST"
  n=$((n + 1))
done < <(cd "$DIVERGENT_DIR" && find . -type f -iname '*.md' -printf '%P\0' | sort -z)

if [ "$n" -lt 10 ]; then
  log "ERROR: only $n .md files available to diverge (need 10). Fixture too small?"
  exit 1
fi
log "divergent-10 manifest → $MANIFEST ($n entries)"

# ── 5. summary (NUMBERS / COUNTS ONLY — no content, no titles) ───────────────
count_ext() { find "$1" -type f -iname "*.$2" | wc -l | tr -d ' '; }
total_files() { find "$1" -type f | wc -l | tr -d ' '; }
dir_size() { du -sh "$1" 2>/dev/null | cut -f1; }

log "──────────────────────────────────────────────────────────────"
log "FIXTURE SUMMARY (counts only — no content):"
log "  ref            : $REF ($REF_SHA)"
log "  lifeos/        : $(total_files "$LIFEOS_DIR") files, $(dir_size "$LIFEOS_DIR")"
log "    .md          : $(count_ext "$LIFEOS_DIR" md)"
log "    .canvas      : $(count_ext "$LIFEOS_DIR" canvas)"
log "    .base        : $(count_ext "$LIFEOS_DIR" base)"
log "    .json        : $(count_ext "$LIFEOS_DIR" json)"
log "    images (png/jpg/webp): $(( $(count_ext "$LIFEOS_DIR" png) + $(count_ext "$LIFEOS_DIR" jpg) + $(count_ext "$LIFEOS_DIR" webp) ))"
log "  lifeos-identical/   : $(total_files "$IDENTICAL_DIR") files, $(dir_size "$IDENTICAL_DIR")"
log "  lifeos-divergent-10/: $(total_files "$DIVERGENT_DIR") files, $(dir_size "$DIVERGENT_DIR") (10 .md diverged)"
log "──────────────────────────────────────────────────────────────"
log "DONE. Fixtures are gitignored (fixtures/lifeos*) — NEVER commit them."
