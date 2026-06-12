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
 * `"notes/a.md"` + (`dev-b`, `"2026-06-11T12-00-00Z"`) →
 * `"notes/a (conflict, dev-b, 2026-06-11T12-00-00Z).md"`.
 *
 * The suffix is inserted before the LAST extension (so dotted filenames keep their
 * real extension). A path with no extension still works — the suffix is appended
 * with no trailing dot: `"notes/README"` → `"notes/README (conflict, …)"`.
 */
export function conflictArtifactPath(
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
  if (!hasExt) return (original + suffix) as VaultPath;
  return (original.slice(0, dot) + suffix + original.slice(dot)) as VaultPath;
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
