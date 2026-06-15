/**
 * FsDocStore — DocStorePort backed by a flat directory of files.
 *
 * Each DocId is encoded as its hex representation of UTF-8 bytes so the
 * filename is filesystem-safe regardless of what characters the DocId contains.
 * Decoding is the reverse: parse hex back to UTF-8. This is simpler and more
 * debuggable than base64url.
 *
 * Writes are atomic (temp file + rename + parent-dir fsync) for crash safety.
 */

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { DocId, DocStorePort } from "@zync/core";
import { TMP_PREFIX, isEnoent, atomicWriteBytes } from "./fs-utils.js";

function encodeDocId(id: DocId): string {
  return Buffer.from(id, "utf8").toString("hex");
}

function decodeDocId(hex: string): DocId {
  return Buffer.from(hex, "hex").toString("utf8") as DocId;
}

export class FsDocStore implements DocStorePort {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  async load(id: DocId): Promise<Uint8Array | null> {
    const file = path.join(this.dir, encodeDocId(id));
    try {
      const buf = await fsp.readFile(file);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async save(id: DocId, snapshot: Uint8Array): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, encodeDocId(id));
    await atomicWriteBytes(file, snapshot);
  }

  async delete(id: DocId): Promise<void> {
    try {
      await fsp.unlink(path.join(this.dir, encodeDocId(id)));
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  async list(): Promise<DocId[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const ids: DocId[] = [];
    for (const e of entries) {
      if (e.isFile() && !e.name.startsWith(TMP_PREFIX)) {
        ids.push(decodeDocId(e.name));
      }
    }
    return ids;
  }
}

export async function makeTmpDocStore(): Promise<{ store: FsDocStore; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zync-docstore-"));
  return { store: new FsDocStore(dir), dir };
}
