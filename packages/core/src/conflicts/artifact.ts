import type { DeviceId, VaultPath, VaultPort } from "../ports.js";
import { sha256OfText } from "../hash.js";
import type { EchoLedger } from "../bridge/echo.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Conflict artifacts — the losing side of a conflict, parked next to the original.
 *
 * The naming is DETERMINISTIC so every device computes the SAME artifact path for
 * the same conflict. Two devices that each detect the conflict (then sync) must NOT
 * end up with two copies of the loser: identical path + idempotent write ⇒ one file.
 *
 * The `ts` token MUST be deterministic-per-conflict — derived by the caller from the
 * losing content hash or event/stamp metadata, NEVER from a local `Date.now()`. A
 * wall-clock `now()` would differ across devices and defeat the whole point (each
 * device would mint a different path → duplicate artifacts after sync).
 */

/**
 * Insert ` (conflict, <deviceId>, <ts>)` before the extension of `original`, BESIDE
 * the original (dotfile-safe, no folder move). `"notes/a.md"` →
 * `"notes/a (conflict, dev-b, 2026-06-11T12-00-00Z).md"`; `"notes/README"` (no ext) →
 * `"notes/README (conflict, …)"`.
 *
 * This is the SHARED naming rule. It has TWO callers with DIFFERENT placement policies:
 *   - {@link conflictArtifactPath} (real conflict BACKUPS) wraps this under `_conflicts/`
 *     so the loser artifact is DEVICE-LOCAL and never syncs.
 *   - `orphanRecoveryPath` (concurrent-create loser RECOVERY) uses it BESIDE-ORIGINAL:
 *     the recovered doc is a LIVE, SYNCING index entry, so it must NOT be relocated or
 *     excluded. Decoupling the two is deliberate — a shared `_conflicts/` prefix would
 *     make recovered orphans permanently-pending, non-syncing docs.
 */
export function withConflictSuffix(
  original: VaultPath,
  deviceId: DeviceId,
  ts: string,
): VaultPath {
  const suffix = ` (conflict, ${deviceId}, ${ts})`;
  const slash = original.lastIndexOf("/");
  const dot = original.lastIndexOf(".");
  // Only treat the dot as an extension if it is part of the FILENAME (after the
  // last slash) and not the very first character of that filename (a dotfile).
  const hasExt = dot > slash + 1;
  return (
    hasExt ? original.slice(0, dot) + suffix + original.slice(dot) : original + suffix
  ) as VaultPath;
}

/**
 * `"notes/a.md"` + (`dev-b`, `"2026-06-11T12-00-00Z"`) →
 * `"_conflicts/notes/a (conflict, dev-b, 2026-06-11T12-00-00Z).md"`.
 *
 * A REAL conflict backup (the losing side of an auto-resolved merge) is placed under
 * the top-level `_conflicts/` folder — DEVICE-LOCAL, excluded from sync by
 * {@link isConflictArtifactPath} — with the original subpath preserved and the suffix
 * inserted before the extension via {@link withConflictSuffix}.
 */
export function conflictArtifactPath(
  original: VaultPath,
  deviceId: DeviceId,
  ts: string,
): VaultPath {
  return `_conflicts/${withConflictSuffix(original, deviceId, ts)}` as VaultPath;
}

/**
 * True for a conflict-artifact path: anything under the top-level `_conflicts/` folder.
 *
 * FOLDER-ONLY by design. A beside-original ` (conflict, …)` filename is INDISTINGUISHABLE
 * from an orphan-RECOVERY path (which must SYNC), so a filename regex would wrongly
 * exclude synced recovery docs — and risk unsyncing a real note a user named that way.
 * The folder prefix is the only safe, false-positive-free rule.
 */
export function isConflictArtifactPath(path: VaultPath): boolean {
  return path.startsWith("_conflicts/");
}

/**
 * Write the losing side of a conflict as a conflict artifact, IDEMPOTENTLY.
 *
 * The path is the deterministic {@link conflictArtifactPath}. If the artifact
 * already exists on disk with byte-identical content, the write is skipped (so a
 * re-run — or a second device that already synced the same artifact — produces no
 * duplicate write / no spurious fs event).
 *
 * INVARIANT (matches the ingest pipeline): `echo.recordWrite` IMMEDIATELY precedes
 * `vault.writeAtomic`, so the watcher event for the artifact bytes is recognised as
 * our own and never re-ingested.
 *
 * Returns the artifact path.
 */
export async function writeConflictArtifact(
  deps: { vault: VaultPort; echo: EchoLedger },
  original: VaultPath,
  losingText: string,
  deviceId: DeviceId,
  ts: string,
): Promise<VaultPath> {
  const artifactPath = conflictArtifactPath(original, deviceId, ts);
  const bytes = utf8(losingText);

  // Idempotency: if the artifact already holds identical bytes, write nothing.
  const existing = await deps.vault.read(artifactPath);
  if (existing !== null && bytesEqual(existing, bytes)) return artifactPath;

  deps.echo.recordWrite(artifactPath, await sha256OfText(losingText));
  await deps.vault.writeAtomic(artifactPath, bytes);
  return artifactPath;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
