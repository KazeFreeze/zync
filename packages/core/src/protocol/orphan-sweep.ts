import type { DeviceId, DocId, VaultPath, VaultPort } from "../ports.js";
import type { Route } from "../classify/classify.js";
import { sha256OfText } from "../hash.js";
import type { EchoLedger } from "../bridge/echo.js";
import type { BaseStore } from "../bridge/base.js";
import type { Inbox } from "../conflicts/inbox.js";
import { conflictArtifactPath } from "../conflicts/artifact.js";
import type { IndexDoc } from "./index-doc.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * The doc's create-metadata, read from the CRDT doc's meta map by the engine. ALL
 * fields are properties OF THE DOC (not of the recovering device), so every device
 * derives the SAME recovery path — the property that makes the sweep idempotent
 * across N devices.
 */
export interface OrphanMeta {
  createdBy: DeviceId;
  createdTs: string;
  originalPath: VaultPath;
}

/**
 * Orphan recovery (design §9.4, plan §C). An ORPHAN is a docId present in the
 * doc-set but NOT bound by any LIVE tree entry — the byproduct of concurrent-create:
 * N devices each create the same path with DISTINCT docIds; the `tree` Y.Map LWW
 * binds the path to ONE winner, leaving the other docId(s) orphaned. Rather than
 * drop their content, the sweep RECOVERS each to a DETERMINISTIC conflict path
 * `name (conflict, <createdBy>, <createdTs>).md` (tokens from the doc's create-
 * metadata so all devices agree), REUSING the orphan's original docId — no new
 * create. Content is never dropped and the sweep is idempotent across runs AND
 * across N devices.
 */

/** docIds present in the doc-set but NOT bound by any LIVE (non-tombstoned) tree entry. */
export function findOrphans(index: IndexDoc, docSet: DocId[]): DocId[] {
  const bound = new Set<DocId>(index.liveEntries().map(([, e]) => e.docId));
  return docSet.filter((id) => !bound.has(id));
}

/**
 * The DETERMINISTIC recovery path from create-metadata: `"x/a.md"` →
 * `"x/a (conflict, <createdBy>, <createdTs>).md"`. A pure function of `meta` — every
 * device computes the same name (reuses {@link conflictArtifactPath}'s suffix rule).
 */
export function orphanRecoveryPath(meta: OrphanMeta): VaultPath {
  return conflictArtifactPath(meta.originalPath, meta.createdBy, meta.createdTs);
}

/**
 * Recover ONE orphan: write its text at the deterministic {@link orphanRecoveryPath}
 * (echo-record → writeAtomic, base BEFORE file for torn-pair safety), bind that path
 * → docId in the tree REUSING the orphan docId, and surface one inbox entry.
 *
 * IDEMPOTENT: the path/docId binding is the same on every run (LWW re-set of one
 * key), the inbox id is deterministic (single LWW key, never a duplicate), and an
 * identical-bytes re-write is suppressed (no spurious fs event). Re-running — or a
 * second device that already synced the same recovery — is a no-op.
 */
export async function recoverOrphan(
  deps: {
    vault: VaultPort;
    echo: EchoLedger;
    index: IndexDoc;
    inbox: Inbox;
    base: BaseStore;
    substrate: string;
  },
  args: { docId: DocId; text: string; type: Route; meta: OrphanMeta },
): Promise<{ path: VaultPath }> {
  const { vault, echo, index, inbox, base, substrate } = deps;
  const { docId, text, type, meta } = args;

  const recoveredPath = orphanRecoveryPath(meta);
  const hash = await sha256OfText(text);
  const bytes = utf8(text);

  // Base BEFORE file (torn-pair safe); adopt-pending until the doc next attaches.
  // Idempotency: skip the re-save when an identical base already exists so a re-run
  // emits no spurious fs event for the base file either.
  const existingBase = await base.load(docId);
  if (existingBase?.fileHash !== hash) {
    // The recovered orphan is a freshly-bound LOCAL content (like a seed) not yet relay-acked:
    // working base = recovered text, acked/recovery base = empty (0b-3 crash-window no-loss) so a
    // crash during recovery keeps the content rather than reverting it.
    await base.save(docId, {
      baseText: text,
      fileHash: hash,
      crdtToken: null,
      substrate,
      ackedText: "",
      ackedHash: await sha256OfText(""),
    });
  }

  // Idempotency: only write (and echo-record) when the bytes are not already on disk.
  const existing = await vault.read(recoveredPath);
  if (existing === null || !bytesEqual(existing, bytes)) {
    echo.recordWrite(recoveredPath, hash);
    await vault.writeAtomic(recoveredPath, bytes);
  }

  // Bind the recovered path → the REUSED orphan docId (LWW-stable, re-set is a no-op).
  index.setStamp(recoveredPath, docId, type, hash);

  // One inbox entry; the id is deterministic (kind:path:docId) so it never duplicates.
  inbox.add({
    id: `conflict:${recoveredPath}:${docId}`,
    kind: "conflict",
    path: recoveredPath,
    docId,
    detail: `Recovered concurrently-created note as ${recoveredPath}.`,
  });

  return { path: recoveredPath };
}

/**
 * Sweep ALL orphans. `orphanData(docId)` yields the orphan doc's text + create-
 * metadata + route (the engine reads these from the CRDT doc and its meta map).
 * ASYNC because the engine MATERIALIZES the orphan from its local docStore snapshot
 * (an awaited load) to read the content + meta. A `null` result means this device
 * does NOT own the orphan's snapshot — only the OWNING device can recover it (the
 * recovered binding + content then replicate via normal sync), so such an orphan is
 * skipped here. Returns the recovered `{ docId, path }` bindings. Idempotent across
 * runs (a recovered orphan becomes bound, so the next sweep skips it) and across N
 * devices (the recovery path is a pure function of the doc's create-metadata).
 */
export async function orphanSweep(
  deps: {
    vault: VaultPort;
    echo: EchoLedger;
    index: IndexDoc;
    inbox: Inbox;
    base: BaseStore;
    substrate: string;
  },
  args: {
    index: IndexDoc;
    docSet: DocId[];
    orphanData: (docId: DocId) => Promise<{ text: string; type: Route; meta: OrphanMeta } | null>;
  },
): Promise<{ recovered: { docId: DocId; path: VaultPath }[] }> {
  const orphans = findOrphans(args.index, args.docSet);
  const recovered: { docId: DocId; path: VaultPath }[] = [];

  for (const docId of orphans) {
    const data = await args.orphanData(docId);
    if (data === null) continue; // not this device's orphan — the owner recovers it.
    const { path } = await recoverOrphan(deps, {
      docId,
      text: data.text,
      type: data.type,
      meta: data.meta,
    });
    recovered.push({ docId, path });
  }

  return { recovered };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
