import type { Caps } from "../classify/classify.js";
import { classify, type Route } from "../classify/classify.js";
import type { CrdtDoc, DocId, Sha256, VaultPath, VaultPort } from "../ports.js";
import { sha256OfBytes, sha256OfText } from "../hash.js";
import { diffToEdits, merge3 } from "./merge.js";
import type { EchoLedger } from "./echo.js";
import type { BaseStore } from "./base.js";
import type { FileAuthority } from "./fsm.js";
import type { IndexDoc } from "../protocol/index-doc.js";
import type { EngineStateStore } from "../ports.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Injected SEAMS that keep the ingest pipeline decoupled from debounce/conflict/attach.
 * The engine (Tasks 9/12/13) owns the real implementations.
 */
export interface IngestDeps {
  vault: VaultPort;
  index: IndexDoc;
  echo: EchoLedger;
  base: BaseStore;
  engineState: EngineStateStore;
  caps: Caps; // from classify
  substrate: string; // e.g. "yjs"
  /** undefined ⇒ adopt-pending (no CRDT side attached yet). */
  getAttachedDoc: (docId: DocId) => CrdtDoc | undefined;
  getAuthority: (path: VaultPath) => FileAuthority;
  /** Mint a unique id for a first-seen path (ulid in prod; counter in tests). */
  newDocId: () => DocId;
  /** Engine debounces the index stamp bump (Task 13). */
  bumpStamp: (path: VaultPath, docId: DocId, route: Route, sha: Sha256) => void;
  /** Task 9 wires the conflict artifact; here we just emit the losing text. */
  emitConflict: (path: VaultPath, losingText: string) => void;
}

export type IngestResult =
  | { action: "skipped-echo" | "skipped-not-prose" | "skipped-deleted" }
  | { action: "ingested-clean"; docId: DocId; newText: string; activeBound: boolean }
  | {
      action: "ingested-conflict";
      docId: DocId;
      winningText: string;
      losingText: string;
      activeBound: boolean;
    };

/**
 * The INGEST pipeline (file → CRDT): the heart of the file⇄CRDT bridge.
 *
 * Composes the existing core pieces — sticky `classify`, `EchoLedger`,
 * `FileAuthority`, `BaseStore`, `merge3`/`diffToEdits`, `IndexDoc` stamp helpers,
 * and `hash.ts` — behind injected SEAMS. No real timers: the debounce is the
 * engine's job via `bumpStamp`.
 *
 * INVARIANT: `echo.recordWrite` ALWAYS immediately precedes the matching
 * `vault.writeAtomic`, so our own write-back never looks external.
 */
export class IngestPipeline {
  readonly #deps: IngestDeps;

  constructor(deps: IngestDeps) {
    this.#deps = deps;
  }

  async onVaultWrite(path: VaultPath): Promise<IngestResult> {
    const d = this.#deps;

    // 0. Read disk bytes. null ⇒ the file is gone (delete handled elsewhere).
    const bytes = await d.vault.read(path);
    if (bytes === null) return { action: "skipped-deleted" };

    // 1. Sticky classify: a known path keeps its index route; else classify fresh.
    const entry = d.index.get(path);
    const route = entry?.type ?? classify(path, bytes, d.caps).route;
    if (route !== "crdt-prose") return { action: "skipped-not-prose" };

    // 2. docId: reuse the index's, or mint one for a first-seen path.
    const docId = entry?.docId ?? d.newDocId();

    // 3. Echo: is this our own write-back reflecting off the watcher?
    const diskHash = await sha256OfBytes(bytes);
    if (d.echo.isEcho(path, diskHash)) return { action: "skipped-echo" };

    // 4. Authority: an active-bound file is bound to a live editor. The "detach →
    //    3-way merge → rebind" of the design IS this same ingest merge applied to the
    //    ATTACHED doc — the editor follows the Y.Text, so converging the CRDT converges
    //    the editor live ("rebind" is implicit). The editor's in-flight edits are already
    //    the `crdt` arm of merge3(base, disk, crdt). So active-bound = inactive in core;
    //    we only TAG the result so callers/tests can see the active-bound path ran.
    const activeBound = d.getAuthority(path).onExternalWrite() === "detach-merge-rebind";

    // 5. 3-way merge. With no CRDT side attached (adopt-pending) we feed the base
    //    as the "crdt" arm so `merge3(base, disk, base)` takes disk — NEVER drops it.
    const diskText = new TextDecoder().decode(bytes);
    const baseRec = await d.base.load(docId);
    const baseText = baseRec?.baseText ?? "";
    const doc = d.getAttachedDoc(docId);
    const crdtText = doc ? doc.getText() : baseText;
    const { merged, clean } = merge3(baseText, diskText, crdtText);

    // 6. Apply.
    let newText: string;
    let result: IngestResult;
    if (clean) {
      newText = merged;
      // Bring the CRDT up to the merge result (no-op if already equal).
      if (doc && newText !== crdtText) {
        doc.applyEdits(diffToEdits(crdtText, newText), "local-bridge");
      }
      await this.#writeBackIfChanged(path, diskText, newText);
      result = { action: "ingested-clean", docId, newText, activeBound };
    } else {
      // merge3 contract: on conflict `merged === crdt`, the CRDT wins.
      newText = crdtText;
      d.emitConflict(path, diskText); // disk side becomes the artifact
      await this.#writeBackIfChanged(path, diskText, newText);
      result = {
        action: "ingested-conflict",
        docId,
        winningText: crdtText,
        losingText: diskText,
        activeBound,
      };
    }

    // 7. Persist base + engine state + bump the index stamp (debounced by engine).
    const newHash = await sha256OfText(newText);
    await d.base.save(docId, {
      baseText: newText,
      fileHash: newHash,
      crdtToken: doc ? doc.encodeStateVector() : null,
      substrate: d.substrate,
    });
    await d.engineState.markDirty(docId);
    d.bumpStamp(path, docId, "crdt-prose", newHash);

    return result;
  }

  /**
   * Write `newText` back to disk only when it differs from what is already there.
   * INVARIANT: record the echo IMMEDIATELY before the write, always.
   */
  async #writeBackIfChanged(path: VaultPath, diskText: string, newText: string): Promise<void> {
    if (newText === diskText) return;
    this.#deps.echo.recordWrite(path, await sha256OfText(newText));
    await this.#deps.vault.writeAtomic(path, utf8(newText));
  }
}
