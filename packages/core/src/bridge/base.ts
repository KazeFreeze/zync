import type { DocId, Sha256, VaultPath, VaultPort } from "../ports.js";

export interface BaseRecord {
  baseText: string; // the WORKING merge base TEXT — merge3 needs reconstructable text, not a one-way hash (NEW-7 BLOCKER-1)
  fileHash: Sha256; // quick compare / echo (the working base's hash)
  crdtToken: Uint8Array | null; // state vector; null = "adopt-pending" until first attach (0b-2 §A/§B)
  substrate: string;
  /**
   * The last RELAY-ACKED content TEXT — the CRASH-RECOVERY merge base (0b-3 crash-window no-loss).
   *
   * `baseText` is the WORKING base: a LOCAL ingest/reconcile advances it to the just-edited
   * content immediately (so the next ingest merges against it). But that edit may NOT have
   * reached the relay yet. If the device is SIGKILL'd in that window and restarts with a
   * PRISTINE/stale reloaded CRDT doc, reconciling against the WORKING base (== the edit) makes
   * `merge3(base=EDIT, disk=EDIT, crdt=PRISTINE)` see only the CRDT as changed → pristine wins
   * → the disk edit is REVERTED (silent data loss). So we ALSO persist `ackedText`: the content
   * the relay has actually confirmed receipt of (advanced ONLY by the catch-up ack gate and by
   * remote-origin outbound writes, whose content came FROM the relay). The crash-recovery dirty
   * reconcile uses `ackedText` as its merge base, so `merge3(acked=PRISTINE, disk=EDIT,
   * crdt=PRISTINE)` correctly keeps the DISK EDIT and re-pushes it.
   *
   * BACKWARD-COMPAT / ERGONOMICS: OPTIONAL on save — a caller that does not distinguish working
   * from acked (or an older on-disk record) omits them and {@link BaseStore.save}/{@link
   * BaseStore.load} default them to `baseText`/`fileHash` (fully-acked, correct for steady state).
   * Callers that must keep the recovery base LAGGING an unpushed edit (ingest, seed, the dirty
   * reconcile) set them explicitly. `load` ALWAYS returns them populated.
   */
  ackedText?: string;
  ackedHash?: Sha256; // the last-acked content's hash (the recovery anchor for the disk-ahead guard)
}

interface SerializedBase {
  baseText: string;
  fileHash: Sha256;
  crdtTokenB64: string | null; // null mirrors an adopt-pending BaseRecord (crdtToken === null)
  substrate: string;
  ackedText?: string; // absent in pre-0b-3 records ⇒ defaults to baseText on load
  ackedHash?: Sha256; // absent in pre-0b-3 records ⇒ defaults to fileHash on load
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
      // Pre-0b-3 records have no acked* fields ⇒ treat the working base as fully-acked.
      ackedText: s.ackedText ?? s.baseText,
      ackedHash: s.ackedHash ?? s.fileHash,
    };
  }

  async save(docId: DocId, rec: BaseRecord): Promise<void> {
    const s: SerializedBase = {
      baseText: rec.baseText,
      fileHash: rec.fileHash,
      substrate: rec.substrate,
      crdtTokenB64: rec.crdtToken === null ? null : bytesToB64(rec.crdtToken),
      // Default an omitted acked base to the working base (fully-acked, steady-state semantics).
      ackedText: rec.ackedText ?? rec.baseText,
      ackedHash: rec.ackedHash ?? rec.fileHash,
    };
    await this.vault.writeAtomic(this.path(docId), new TextEncoder().encode(JSON.stringify(s)));
  }

  /**
   * Remove a doc's base record — the delete/tombstone cleanup (otherwise a deleted note leaves an
   * orphaned `<docId>.json` behind forever). Idempotent: every {@link VaultPort.remove} implementation
   * is a no-op on a missing file, so calling this for a doc that never had a base record is safe.
   */
  async delete(docId: DocId): Promise<void> {
    await this.vault.remove(this.path(docId));
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
