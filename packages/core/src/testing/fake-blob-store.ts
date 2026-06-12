import type { BlobStorePort, Sha256 } from "../ports.js";

/**
 * In-memory {@link BlobStorePort} for tests: a `Map<string, Uint8Array>` keyed by
 * sha. Models a content-addressed blob store (e.g. S3/R2). Methods return resolved
 * promises (no real I/O) and are intentionally NOT marked `async` so `require-await`
 * stays satisfied, matching the {@link FakeVault}/{@link FakeDocStore} style.
 *
 * `get` throws if the sha is absent (a missing blob is a programming error in the
 * eager path, not a normal control-flow signal).
 */
export class FakeBlobStore implements BlobStorePort {
  private readonly blobs = new Map<string, Uint8Array>();

  has(sha: Sha256): Promise<boolean> {
    return Promise.resolve(this.blobs.has(sha));
  }

  put(sha: Sha256, data: Uint8Array): Promise<void> {
    this.blobs.set(sha, data);
    return Promise.resolve();
  }

  get(sha: Sha256): Promise<Uint8Array> {
    const data = this.blobs.get(sha);
    if (data === undefined) {
      return Promise.reject(new Error(`FakeBlobStore: no blob for sha ${sha}`));
    }
    return Promise.resolve(data);
  }

  /**
   * TEST-ONLY escape hatch: store `bytes` UNDER `sha` WITHOUT verifying that the
   * bytes actually hash to it. This deliberately seeds a CORRUPT blob so the
   * "corrupt-on-read" path (`BlobEngine.materialize` hash-verify) can be exercised.
   * NEVER use this in production code — the real put path is content-addressed.
   */
  putRaw(sha: Sha256, bytes: Uint8Array): void {
    this.blobs.set(sha, bytes);
  }
}
