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
    await d.base.save(docId, {
      baseText: newText,
      fileHash: newHash,
      crdtToken: doc.encodeStateVector(),
      substrate: d.substrate,
    });

    // 4. Write to disk ONLY if it differs — and echo-record IMMEDIATELY before the write.
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
