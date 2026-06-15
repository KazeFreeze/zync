/**
 * snapshot.ts — Yjs state persistence for the Zync relay.
 *
 * CONTENT-BLIND: stores and loads raw Y.encodeStateAsUpdate bytes only.
 * Never decodes a Y.Doc to text. Never interprets note content.
 *
 * SnapshotStore — a small, testable fs abstraction:
 *   save(name, bytes) → write <dir>/<safe-name>.bin (durable atomic write)
 *   load(name)        → read bytes | null if absent
 *
 * makeSnapshotHooks — returns Hocuspocus-compatible hook impls that wire
 * SnapshotStore into onLoadDocument / onStoreDocument.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import type { onLoadDocumentPayload, onStoreDocumentPayload } from "@hocuspocus/server";

// ---------------------------------------------------------------------------
// Filesystem-safe name encoding
// ---------------------------------------------------------------------------

/**
 * Convert an arbitrary Hocuspocus documentName (may contain slashes, dots,
 * Unicode, special chars) to a safe filename component.
 *
 * Strategy: base64url-encode the UTF-8 bytes (filesystem-safe alphabet),
 * then append a deterministic 16-char SHA-256 hex suffix derived from the FULL
 * original name. This means two doc names that share a long common prefix
 * (and would collide after truncation) still produce DIFFERENT filenames.
 *
 * Example for a 500-char name:
 *   base64url(name).slice(0, 200) + "-" + sha256(name).slice(0, 16)
 */
function safeName(docName: string): string {
  const encoded = Buffer.from(docName, "utf8").toString("base64url");
  const suffix = createHash("sha256").update(docName, "utf8").digest("hex").slice(0, 16);
  return `${encoded.slice(0, 200)}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Durable atomic write (inline — not imported from headless-client)
// ---------------------------------------------------------------------------

/**
 * Write `data` atomically to `targetPath`:
 *   write temp → fh.datasync() → fh.close() → rename → parent-dir datasync.
 * On any failure after the temp file is created, best-effort unlinks the temp
 * so no orphan .tmp files linger on disk.
 * Uses a random suffix (Math.random().toString(36).slice(2)) so concurrent
 * saves of the same doc don't collide on the temp file name.
 */
async function atomicWriteBytes(targetPath: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.zync-snap-tmp-${Math.random().toString(36).slice(2)}`);

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

  // Datasync the parent directory so the rename entry is durable on crash.
  const dirFh = await fsp.open(dir, "r");
  try {
    await dirFh.datasync();
  } finally {
    await dirFh.close();
  }
}

// ---------------------------------------------------------------------------
// SnapshotStore
// ---------------------------------------------------------------------------

export class SnapshotStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private filePath(name: string): string {
    return path.join(this.dir, `${safeName(name)}.bin`);
  }

  /** Load persisted Yjs update bytes for the given doc name, or null. */
  async load(name: string): Promise<Uint8Array | null> {
    const fp = this.filePath(name);
    try {
      const buf = await fsp.readFile(fp);
      return new Uint8Array(buf);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Persist Yjs update bytes for the given doc name (durable atomic write). */
  async save(name: string, bytes: Uint8Array): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const fp = this.filePath(name);
    await atomicWriteBytes(fp, bytes);
  }
}

// ---------------------------------------------------------------------------
// Hocuspocus hook wiring
// ---------------------------------------------------------------------------

export interface SnapshotHooks {
  onLoadDocument(payload: onLoadDocumentPayload): Promise<void>;
  onStoreDocument(payload: onStoreDocumentPayload): Promise<void>;
}

/**
 * Return Hocuspocus hook implementations that persist opaque Yjs update bytes
 * to the given SnapshotStore.
 *
 * CONTENT-BLIND: uses encodeStateAsUpdate (opaque binary) and applyUpdate only.
 * No Y.Doc text decoding occurs.
 *
 * onStoreDocument failures are caught and logged loudly but NOT rethrown —
 * a snapshot write failure must not crash the relay or its active sessions.
 */
export function makeSnapshotHooks(store: SnapshotStore): SnapshotHooks {
  return {
    async onLoadDocument({ document, documentName }) {
      const bytes = await store.load(documentName);
      if (bytes !== null) {
        // Apply the persisted update to the freshly-created Y.Doc.
        // This is content-blind: applyUpdate processes opaque CRDT bytes.
        applyUpdate(document, bytes);
      }
    },

    async onStoreDocument({ document, documentName }) {
      // encodeStateAsUpdate encodes the full doc state as opaque binary.
      // Content-blind: we store bytes, never decode to text.
      const bytes = encodeStateAsUpdate(document);
      try {
        await store.save(documentName, bytes);
      } catch (err: unknown) {
        // Loud error log but do NOT rethrow — a persistence failure must not
        // crash the relay or terminate active client sessions.
        console.error(`[zync-snapshot] ERROR persisting "${documentName}": ${String(err)}`);
      }
    },
  };
}
