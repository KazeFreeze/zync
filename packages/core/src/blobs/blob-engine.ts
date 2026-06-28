import type {
  BlobStorePort,
  ClockPort,
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
import { BlobFetchQueue } from "./blob-fetch-queue.js";
import type { MaterializeOutcome } from "./blob-fetch-queue.js";

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
  clock: ClockPort;
  concurrency: number;
  maxInFlightBytes: number;
  maxRetries: number;
  retryTickMs: number;
  /** Aggregate failure surface: called with the CURRENT full failed-path set whenever it changes. */
  onBlobFailure: (failedPaths: VaultPath[]) => void;
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
  readonly #queue: BlobFetchQueue;

  constructor(deps: BlobEngineDeps) {
    this.#deps = deps;
    this.#queue = new BlobFetchQueue({
      materialize: (p, s) => this.materialize(p, s),
      manifestEntries: () => this.manifestEntries(),
      clock: deps.clock,
      onFailure: deps.onBlobFailure,
      concurrency: deps.concurrency,
      maxInFlightBytes: deps.maxInFlightBytes,
      maxRetries: deps.maxRetries,
      retryTickMs: deps.retryTickMs,
    });
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
   * GENERATION-AWARE fetch: materialize the blob whose CURRENT manifest sha is
   * `expectedSha`. Fetches the bytes, HASH-VERIFIES them, and writes the vault
   * (echo-recorded first so the resulting fs event is not re-ingested). Returns a
   * {@link MaterializeOutcome}:
   *  - `"superseded"` — the manifest entry is absent, or its sha no longer equals
   *    `expectedSha` (checked both BEFORE fetch and AGAIN immediately before the
   *    write to close the fetch-window generation race). Nothing is written; the
   *    queue re-enqueues the path under its fresh sha via the manifest observe.
   *  - `"already"`  — the file on disk already hashes to `expectedSha` (idempotent
   *    short-circuit; also breaks the eager re-materialize feedback loop).
   *  - `"written"`  — the verified bytes were written to the vault.
   *
   * If the fetched bytes do NOT hash to `expectedSha`, throws {@link
   * CorruptBlobError} and DOES NOT write the vault.
   */
  async materialize(path: VaultPath, expectedSha: Sha256): Promise<MaterializeOutcome> {
    const d = this.#deps;
    const entry = d.manifest.get(path);
    if (entry?.sha256 !== expectedSha) return "superseded"; // manifest moved/absent

    // IDEMPOTENCY: disk already matches -> nothing to fetch (also breaks the eager re-materialize loop).
    const onDisk = await d.vault.read(path);
    if (onDisk !== null && (await sha256OfBytes(onDisk)) === expectedSha) return "already";

    const bytes = await d.blobStore.get(expectedSha);
    const actual = await sha256OfBytes(bytes);
    if (actual !== expectedSha) {
      throw new CorruptBlobError({ path, expected: expectedSha, actual });
    }
    // RE-VALIDATE immediately before the write (generation-race close): if the manifest moved
    // during the fetch, abort -> the queue re-enqueues the current sha.
    const now = d.manifest.get(path);
    if (now?.sha256 !== expectedSha) return "superseded";

    d.echo.recordWrite(path, expectedSha);
    await d.vault.writeAtomic(path, bytes);
    return "written";
  }

  /**
   * READ-ONLY snapshot of the blob manifest: every `[path, entry]` advertised in the
   * index `blobs` map. The engine's `pendingDocs` blob-accounting (0b-3 Fix 3) reads
   * this to check whether each advertised blob has actually materialized onto THIS
   * device's disk (a follower must not report quiescence while a manifest-advertised
   * blob is still missing). PURE READ — it never mutates the manifest, so calling it
   * from a remote-facing convergence loop is loop-safe.
   */
  manifestEntries(): [VaultPath, BlobManifestEntry][] {
    return this.#deps.manifest.entries().map(([k, v]) => [k as VaultPath, v]);
  }

  /**
   * Observe the manifest and DRIVE the bounded {@link BlobFetchQueue} for eager
   * fetches. Returns the unsubscribe (which also stops the queue).
   *
   * EAGER: start the queue (arms its heal-retry tick), then enqueue every entry
   * ALREADY in the manifest (the initial sweep — `observe` only fires on FUTURE
   * changes, so a follower that attached the index doc after a blob was advertised
   * would otherwise never materialize that pre-existing entry — 0b-3 Fix 3). Each
   * later manifest change re-enqueues its changed paths under their CURRENT sha. The
   * queue is bounded-concurrency, byte-budgeted, typed-retry, and generation-aware
   * (a same-sha in-flight enqueue is a no-op; a newer sha re-targets), and {@link
   * materialize} is idempotent + echo-guarded, so this is loop-safe.
   *
   * LAZY: no queue, no enqueue — bytes are fetched only on read via {@link
   * materialize}.
   */
  start(): Unsubscribe {
    if (this.#deps.policy === "eager") {
      this.#queue.start();
      for (const [p, e] of this.#deps.manifest.entries()) {
        this.#queue.enqueue(p as VaultPath, e.sha256, e.size);
      }
    }
    const unsub = this.#deps.manifest.observe((changed) => {
      if (this.#deps.policy !== "eager") return;
      for (const p of changed) {
        const e = this.#deps.manifest.get(p);
        if (e) this.#queue.enqueue(p as VaultPath, e.sha256, e.size);
      }
    });
    return () => {
      this.#queue.stop();
      unsub();
    };
  }

  /** True once every advertised blob is materialized-or-failed (no queued/in-flight/retry). */
  blobsSettled(): boolean {
    return this.#queue.settled();
  }

  blobProgress(): { materialized: number; total: number; failed: number } {
    return this.#queue.progress();
  }
}
