/**
 * Shared filesystem utilities for the headless-client FS adapters.
 *
 * - TMP_PREFIX: common prefix for all sibling temp files so watcher exclusions
 *   and cleanup are consistent across all three adapters.
 * - isEnoent: thin ENOENT-check to avoid repeating the cast everywhere.
 * - atomicWriteBytes: full POSIX crash-safe write pattern:
 *     1. Write to a sibling temp file.
 *     2. fh.datasync() then fh.close().
 *     3. rename(tmp, target) — atomic on POSIX (same filesystem).
 *     4. Open the parent dir and datasync() it so the rename survives a crash.
 *     On any failure after the temp file is created, best-effort unlink the
 *     temp so it does not linger as an orphan.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const TMP_PREFIX = ".zync-tmp-";

export function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Write `data` atomically to `targetPath`:
 *   write temp → datasync → close → rename → parent-dir datasync.
 * Cleans up the temp file on failure (best-effort).
 */
export async function atomicWriteBytes(targetPath: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `${TMP_PREFIX}${Math.random().toString(36).slice(2)}`);

  const fh = await fsp.open(tmp, "w");
  try {
    await fh.write(data);
    await fh.datasync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fh.close();

  try {
    await fsp.rename(tmp, targetPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }

  // fsync the parent directory so the rename entry is durable.
  const dirFh = await fsp.open(dir, "r");
  try {
    await dirFh.datasync();
  } finally {
    await dirFh.close();
  }
}
