import type {
  BlobStorePort,
  CrdtMap,
  DeviceId,
  IdentityPort,
  Sha256,
  Unsubscribe,
  VaultPath,
  VaultPort,
} from "../ports.js";
import type { EchoLedger } from "../bridge/echo.js";
import { sha256OfBytes } from "../hash.js";
import { CorruptBlobError } from "../errors.js";

/**
 * One row of the index `blobs` map (0b-2 §B): the content-address of a binary /
 * structured blob at a vault path, its byte length, and the device that authored
 * the entry. Stored as a per-key LWW register (`CrdtMap<BlobManifestEntry>`).
 */
export interface BlobManifestEntry {
  sha256: Sha256;
  size: number;
  deviceId: DeviceId;
}

/**
 * Per-device fetch policy:
 *  - `"eager"`: materialize a blob to the vault as soon as its manifest entry
 *    changes (auto-download).
 *  - `"lazy"`: stay manifest-only; bytes are fetched only when {@link
 *    BlobEngine.materialize} is called (materialize-on-read / open).
 */
export type BlobFetchPolicy = "eager" | "lazy";

export interface BlobEngineDeps {
  /** The index `blobs` map — a per-path LWW register of {@link BlobManifestEntry}. */
  manifest: CrdtMap<BlobManifestEntry>;
  /** Content-addressed bytes store (S3/R2-like). */
  blobStore: BlobStorePort;
  vault: VaultPort;
  echo: EchoLedger;
  identity: IdentityPort;
  policy: BlobFetchPolicy;
}

/**
 * The blob client engine: content-addressed file-sync for binaries / structured
 * blobs (0b-2 Task 11). Local writes are hashed, stored once, and published as a
 * manifest entry; remote manifest changes drive eager fetches; reads are
 * hash-verified before they touch the vault.
 *
 * KEEP-OLD-VERSIONS: because blobs are content-addressed (keyed by sha), a NEW
 * write under a new sha NEVER deletes the old sha's bytes — prior versions stay
 * fetchable for any replica still pointing at the old manifest entry. There is NO
 * garbage collection in 0b-2; reclaiming unreferenced shas is a later concern.
 */
export class BlobEngine {
  readonly #deps: BlobEngineDeps;

  constructor(deps: BlobEngineDeps) {
    this.#deps = deps;
  }

  /**
   * A LOCAL binary / structured-blob write: content-address it, store the bytes
   * once (skip if already present), then publish the manifest entry. Old shas are
   * intentionally NOT deleted (keep-old-versions — see class doc).
   */
  async onLocalBlobWrite(path: VaultPath, bytes: Uint8Array): Promise<void> {
    const d = this.#deps;
    const sha = await sha256OfBytes(bytes);
    if (!(await d.blobStore.has(sha))) {
      await d.blobStore.put(sha, bytes);
    }
    d.manifest.set(path, {
      sha256: sha,
      size: bytes.length,
      deviceId: d.identity.deviceId(),
    });
  }

  /**
   * A manifest entry changed (typically remote). `eager` ⇒ materialize the blob
   * to the vault now; `lazy` ⇒ no-op (bytes are fetched on read via {@link
   * materialize}).
   */
  async onManifestChange(path: VaultPath): Promise<void> {
    if (this.#deps.policy === "eager") {
      await this.materialize(path);
    }
  }

  /**
   * Fetch the blob bytes for `path`, HASH-VERIFY them against the manifest sha,
   * and write them to the vault (echo-recorded so the resulting fs event is not
   * re-ingested). Returns the verified bytes.
   *
   * If there is no manifest entry for `path`, throws (a clear programming error —
   * nothing to materialize). If the fetched bytes do NOT hash to the manifest sha,
   * throws {@link CorruptBlobError} and DOES NOT write the vault.
   */
  async materialize(path: VaultPath): Promise<Uint8Array> {
    const d = this.#deps;
    const entry = d.manifest.get(path);
    if (entry === undefined) {
      throw new Error(`BlobEngine.materialize: no manifest entry for ${path}`);
    }

    const bytes = await d.blobStore.get(entry.sha256);
    const actual = await sha256OfBytes(bytes);
    if (actual !== entry.sha256) {
      // Hash-verify FAILED: reject the corrupt blob; the vault is left untouched.
      throw new CorruptBlobError({ path, expected: entry.sha256, actual });
    }

    // echo-record IMMEDIATELY precedes the write (matches the bridge invariant),
    // so the resulting vault event is recognized as our own and not re-ingested.
    d.echo.recordWrite(path, entry.sha256);
    await d.vault.writeAtomic(path, bytes);
    return bytes;
  }

  /**
   * Observe the manifest and drive eager fetches: every changed path is routed
   * through {@link onManifestChange} (eager ⇒ auto-materialize; lazy ⇒ no-op).
   * Returns the unsubscribe.
   */
  start(): Unsubscribe {
    return this.#deps.manifest.observe((changedPaths) => {
      for (const p of changedPaths) {
        void this.onManifestChange(p as VaultPath);
      }
    });
  }
}
