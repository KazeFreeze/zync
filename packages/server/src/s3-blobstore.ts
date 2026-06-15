/**
 * s3-blobstore.ts — S3-compatible blob backend for the Zync blob endpoint.
 *
 * Implements BlobBackend over @aws-sdk/client-s3.
 * Works with MinIO (dev, via docker-compose) and Cloudflare R2 (prod).
 *
 * NOTE: Live MinIO/R2 behavior is DEFERRED to the Docker harness (Phase-0b-3
 * Task 3+). Unit tests for file-endpoint use an in-memory fake backend.
 * Wire S3BlobStore through createServer() in index.ts for the real deployment.
 */

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { BlobBackend } from "./file-endpoint.js";

export interface S3BlobStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Must be true for MinIO path-style URLs. */
  forcePathStyle?: boolean;
}

export class S3BlobStore implements BlobBackend {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3BlobStoreConfig) {
    const s3Config: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    };
    this.client = new S3Client(s3Config);
    this.bucket = config.bucket;
  }

  async has(sha: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: sha }));
      return true;
    } catch (err: unknown) {
      // AWS SDK v3 throws with $metadata.httpStatusCode or with a name.
      const e = err as { $metadata?: { httpStatusCode?: number }; name?: string };
      const status = e.$metadata?.httpStatusCode;
      if (status === 404 || e.name === "NotFound" || e.name === "NoSuchKey") {
        return false;
      }
      throw err;
    }
  }

  async put(sha: string, bytes: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: sha,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
  }

  async get(sha: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: sha }),
    );
    if (!response.Body) {
      throw new Error(`S3BlobStore.get: empty body for key ${sha}`);
    }
    // GetObjectCommand Body is a Readable stream in Node.js.
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
