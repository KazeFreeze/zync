/**
 * Thrown to reject an in-flight `AttachedDoc.synced()` promise when the owning
 * transport is closed before the first state-vector exchange completes (0b-2 §A).
 *
 * Lives in core (not the test surface) so BOTH the in-process test transport and
 * the real Hocuspocus adapter can reject with the SAME typed error.
 */
export class ClosedError extends Error {
  constructor(message = "transport closed before sync") {
    super(message);
    this.name = "ClosedError";
  }
}

import type { Sha256, VaultPath } from "./ports.js";

/**
 * Thrown by the blob engine when a fetched blob's bytes do NOT hash to the sha
 * recorded in the manifest entry (0b-2 §B). Content-addressed blobs MUST be
 * hash-verified on read; a mismatch means the store returned corrupt/tampered
 * bytes, so the engine REJECTS the read and does NOT write the vault. Carries the
 * `path`, the `expected` manifest sha, and the `actual` hash of the fetched bytes.
 */
export class CorruptBlobError extends Error {
  readonly path: VaultPath;
  readonly expected: Sha256;
  readonly actual: Sha256;

  constructor(args: { path: VaultPath; expected: Sha256; actual: Sha256 }) {
    super(`corrupt blob for ${args.path}: expected sha ${args.expected}, got ${args.actual}`);
    this.name = "CorruptBlobError";
    this.path = args.path;
    this.expected = args.expected;
    this.actual = args.actual;
  }
}

/** A TRANSIENT blob-store failure (network / timeout / 5xx) — the fetch queue RETRIES these. */
export class BlobTransientError extends Error {
  readonly sha: Sha256;
  constructor(args: { sha: Sha256; cause?: string }) {
    super(`transient blob error for sha ${args.sha}${args.cause ? `: ${args.cause}` : ""}`);
    this.name = "BlobTransientError";
    this.sha = args.sha;
  }
}

/** The blob bytes are NOT in the store (404). Retried a few times (propagation lag) then parked. */
export class BlobNotFoundError extends Error {
  readonly sha: Sha256;
  constructor(args: { sha: Sha256 }) {
    super(`blob not found for sha ${args.sha}`);
    this.name = "BlobNotFoundError";
    this.sha = args.sha;
  }
}

/** A PERMANENT blob failure (auth 401/403, 413/too-large) — parked immediately, NEVER retried. */
export class BlobPermanentError extends Error {
  readonly sha: Sha256;
  readonly reason: string;
  constructor(args: { sha: Sha256; reason: string }) {
    super(`permanent blob error for sha ${args.sha}: ${args.reason}`);
    this.name = "BlobPermanentError";
    this.sha = args.sha;
    this.reason = args.reason;
  }
}
