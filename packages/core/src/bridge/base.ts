import type { DocId, Sha256, VaultPath, VaultPort } from "../ports.js";

export interface BaseRecord {
  baseText: string; // the merge base TEXT — merge3 needs reconstructable text, not a one-way hash (NEW-7 BLOCKER-1)
  fileHash: Sha256; // quick compare / echo
  crdtToken: Uint8Array | null; // state vector; null = "adopt-pending" until first attach (0b-2 §A/§B)
  substrate: string;
}

interface SerializedBase {
  baseText: string;
  fileHash: Sha256;
  crdtTokenB64: string | null; // null mirrors an adopt-pending BaseRecord (crdtToken === null)
  substrate: string;
}

/**
 * Per-note base store (design §9.3). One small atomic file per note under
 * `<configDir>/zync/base/<docId>.json` — NOT one giant state.json (avoids O(n^2)
 * rewrites). Lives on the vault FS so base and note share a durability domain.
 * Writes base BEFORE the note file so a torn pair recovers safely.
 */
export class BaseStore {
  constructor(
    private readonly vault: VaultPort,
    private readonly configDir: string,
  ) {}

  private path(docId: DocId): VaultPath {
    return `${this.configDir}/zync/base/${docId}.json` as VaultPath;
  }

  async load(docId: DocId): Promise<BaseRecord | null> {
    const bytes = await this.vault.read(this.path(docId));
    if (bytes === null) return null;
    const s = JSON.parse(new TextDecoder().decode(bytes)) as SerializedBase;
    return {
      baseText: s.baseText,
      fileHash: s.fileHash,
      substrate: s.substrate,
      crdtToken: s.crdtTokenB64 === null ? null : b64ToBytes(s.crdtTokenB64),
    };
  }

  async save(docId: DocId, rec: BaseRecord): Promise<void> {
    const s: SerializedBase = {
      baseText: rec.baseText,
      fileHash: rec.fileHash,
      substrate: rec.substrate,
      crdtTokenB64: rec.crdtToken === null ? null : bytesToB64(rec.crdtToken),
    };
    await this.vault.writeAtomic(this.path(docId), new TextEncoder().encode(JSON.stringify(s)));
  }

  /** Atomic-ordering helper: base first, then the note file. */
  async saveThenFile(
    docId: DocId,
    rec: BaseRecord,
    notePath: VaultPath,
    noteBytes: Uint8Array,
  ): Promise<void> {
    await this.save(docId, rec);
    await this.vault.writeAtomic(notePath, noteBytes);
  }
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
