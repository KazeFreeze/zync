import type { CrdtDoc, DocId, IdentityPort, VaultPath, VaultPort } from "../ports.js";
import type { EngineStateStore } from "../ports.js";
import { sha256OfText } from "../hash.js";
import { makeStamp } from "../protocol/stamp.js";
import type { EchoLedger } from "./echo.js";
import type { BaseStore } from "./base.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Injected SEAMS for the OUTBOUND pipeline. `pathOf` resolves a doc back to its
 * vault path — in the engine via the index reverse-lookup; in tests via a stub.
 */
export interface OutboundDeps {
  vault: VaultPort;
  base: BaseStore;
  engineState: EngineStateStore;
  echo: EchoLedger;
  identity: IdentityPort;
  substrate: string;
  /** Resolve doc → path; `undefined` ⇒ an orphan (Task 10 handles recovery). */
  pathOf: (docId: DocId) => VaultPath | undefined;
}

/**
 * The OUTBOUND pipeline (CRDT → file): the mirror of ingest. When a `"remote"`-origin
 * update lands on a doc, reconcile the file so the remote content reaches disk EXACTLY
 * once and the resulting vault `modify` event is recognized by the {@link EchoLedger}
 * (so ingest does NOT bounce it back).
 *
 * Only `"remote"` updates trigger outbound — `local-editor`/`local-bridge` updates are
 * already on disk or are driven by ingest.
 *
 * ORDER IS LOAD-BEARING:
 *  - base is saved BEFORE the file write (torn-pair recovery), and
 *  - `echo.recordWrite` IMMEDIATELY precedes `vault.writeAtomic`, ALWAYS.
 */
export class OutboundPipeline {
  readonly #deps: OutboundDeps;

  constructor(deps: OutboundDeps) {
    this.#deps = deps;
  }

  /** The reconcile (also callable directly in tests). */
  async onRemoteUpdate(doc: CrdtDoc): Promise<void> {
    const d = this.#deps;
    const docId = doc.id;

    // 1. Resolve the path. Orphan ⇒ return (Task 10 handles recovery).
    const path = d.pathOf(docId);
    if (path === undefined) return;

    // 2. Snapshot the new CRDT content + its hash.
    const newText = doc.getText();
    const newHash = await sha256OfText(newText);

    // 3. base BEFORE file (torn-pair recovery): persist the merge base + token first.
    //    A REMOTE-origin update's content came FROM the relay, so it is — by definition —
    //    relay-acked. Advance BOTH the working base AND the acked/recovery base to it (0b-3
    //    crash-window no-loss): a crash after this leaves the recovery base at genuinely-acked
    //    content, never at an unpushed local edit.
    // M1b: a fresh-record save must PRESERVE materializedHash (the durable confirmed-on-disk
    // signal recorded at bootstrap). Without carrying it forward, a remote-update reconcile would
    // clobber it. Step 4 below conditionally writes `newText` to disk; the materialize/settle path
    // owns recording the new content's materializedHash, so we only carry the prior value here.
    const priorBase = await d.base.load(docId);
    await d.base.save(docId, {
      baseText: newText,
      fileHash: newHash,
      crdtToken: doc.encodeStateVector(),
      substrate: d.substrate,
      ackedText: newText,
      ackedHash: newHash,
      materializedHash: priorBase?.materializedHash,
    });

    // 4. Write to disk ONLY if it differs — and echo-record IMMEDIATELY before the write.
    //    CANONICAL-LF (#35 + hash-identity): `newText` is the doc text, which is already LF
    //    (the CRDT only ever received canonicalized prose). Compare against the RAW on-disk
    //    text so a CRLF file is recognized as DIFFERING from the LF doc text and rewritten to
    //    LF — the one-time line-ending churn. (We compare raw, not canonicalized, so a CRLF
    //    receiver file is not falsely judged already-equal and left un-rewritten.) Outbound
    //    only reconciles prose note docs.
    const bytes = await d.vault.read(path);
    const diskText = bytes === null ? null : new TextDecoder().decode(bytes);
    if (diskText !== newText) {
      d.echo.recordWrite(path, newHash);
      await d.vault.writeAtomic(path, utf8(newText));
    }

    // 5. Record that we've reconciled to this content. Do NOT clearDirty: a remote
    //    update does not prove OUR local edits were durably pushed.
    await d.engineState.setSyncedStamp(docId, makeStamp(newHash, d.identity.deviceId()));
  }
}
