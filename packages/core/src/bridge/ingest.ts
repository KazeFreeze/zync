import type { Caps } from "../classify/classify.js";
import { classify, type Route } from "../classify/classify.js";
import type { CrdtDoc, DocId, Sha256, VaultPath, VaultPort } from "../ports.js";
import { canonicalizeProse, sha256OfBytes, sha256OfText } from "../hash.js";
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
  /**
   * SEAM (0b-3 Fix 1): a FIRST-SEEN path just minted `docId` — an AFTER-START create.
   * The engine (which owns identity + clock + the docStore) seeds a canonical CRDT doc
   * for `docId`, writes its `meta.create` ({@link OrphanMeta}), and persists a docStore
   * snapshot — EXACTLY as the bootstrap `seed` path does. Without this an after-start
   * create that LOSES a concurrent same-path race is orphaned with NO meta + NO snapshot,
   * so {@link orphanSweep}'s `orphanData` (which requires BOTH) skips it and its content is
   * lost. Invoked ONLY on the mint branch (never for an existing docId). `text` is the
   * merged content being written. Optional/omitted in unit tests (purely additive).
   */
  onFirstCreate?: (docId: DocId, path: VaultPath, text: string) => Promise<void>;
  /**
   * SEAM (0b-3 crash-window no-loss): persist the ATTACHED doc's current CRDT snapshot to the
   * durable docStore after a local edit was applied to it. The engine owns the docStore, so it
   * implements this; ingest only knows "this attached doc just changed locally — make it durable
   * so a restart reloads the EDIT, not a stale pristine snapshot." Optional/omitted in unit tests
   * (purely additive). NEVER called for an adopt-pending (unattached) doc.
   */
  persistDocSnapshot?: (docId: DocId, doc: CrdtDoc) => Promise<void>;
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

    // 1b. RENAME OLD-KEY GUARD (0b-3, GPT-5.5 follow-up). A `modify` on a path whose index
    //     entry is a TOMBSTONE whose docId is LIVE at a DIFFERENT path is the STALE OLD FILE
    //     of an in-flight rename (the receiver still has it on disk; A re-keyed old→new with
    //     the SAME docId). Ingesting it re-stamps the OLD key LIVE — making the docId live at
    //     BOTH old and new, a FALSE divergent rename that the lexicographic resolver wrongly
    //     collapses onto the OLD path, tombstoning the NEW (renamed) entry and destroying the
    //     renamed file everywhere. The structural reconcile RENAME concern owns this stale old
    //     file (it moves it to the new path or removes it). So SKIP: never resurrect it.
    //     LOOP-SAFE: pure index READ, no write. (The on-disk old file is harmless to leave —
    //     reconcile renames/removes it; `pendingDocs` tracks it until then.)
    if (entry?.deleted === true && this.#docIdLiveElsewhere(entry.docId, path)) {
      return { action: "skipped-deleted" };
    }

    // 2. docId: reuse the index's, or mint one for a first-seen path. A minted docId
    //    is an AFTER-START create: the engine seeds its create-meta + snapshot (step 7a).
    const firstSeen = entry === undefined;
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
    //    CANONICAL-LF (#35 + hash-identity): canonicalize the decoded PROSE to LF HERE,
    //    at the decode boundary, BEFORE it is merged / put into the CRDT / hashed-as-text /
    //    saved to base / stamped. We are inside the `route === "crdt-prose"` branch, so this
    //    only ever touches prose — blobs never reach here. `rawDiskText` keeps the UN-
    //    canonicalized form for the write-back DIFF only (so a CRLF disk file is recognized
    //    as DIFFERING from the LF merge result and rewritten to LF — the one-time line-ending
    //    churn through the EXISTING write path). See {@link canonicalizeProse}.
    const rawDiskText = new TextDecoder().decode(bytes);
    const diskText = canonicalizeProse(rawDiskText);
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
      await this.#writeBackIfChanged(path, rawDiskText, newText);
      result = { action: "ingested-clean", docId, newText, activeBound };
    } else {
      // merge3 contract: on conflict `merged === crdt`, the CRDT wins.
      newText = crdtText;
      d.emitConflict(path, diskText); // disk side becomes the artifact
      await this.#writeBackIfChanged(path, rawDiskText, newText);
      result = {
        action: "ingested-conflict",
        docId,
        winningText: crdtText,
        losingText: diskText,
        activeBound,
      };
    }

    // 7. Persist base + engine state + bump the index stamp (debounced by engine).
    //
    // BASE DISCIPLINE (0b-3 crash-window no-loss). Advance the WORKING base (`baseText`/
    // `fileHash`) to the just-merged content so the NEXT ingest merges against it — but DO
    // NOT advance the ACKED base (`ackedText`/`ackedHash`). This local edit has not reached
    // the relay yet; the acked base must stay at the last RELAY-ACKED content so that, after
    // a SIGKILL+restart with a pristine/stale reloaded CRDT doc, the crash-recovery dirty
    // reconcile merges `merge3(acked=last-acked, disk=EDIT, crdt=pristine)` and KEEPS the disk
    // edit instead of reverting it (the data-loss the prior ack-gate fix did not close).
    const newHash = await sha256OfText(newText);
    const prior = baseRec; // the record loaded in step 5 (may be null on a first-seen path).
    // CRASH-ORDERING (P1). For an EXISTING (already-bound) doc, persist the DIRTY flag BEFORE advancing the
    // working base: a crash between these durable writes must never leave the base ADVANCED-but-NOT-dirty —
    // that wedges on restart (bootstrap's offline-drift guard sees disk==base so does NOT mark dirty, and
    // catch-up skips a clean, stamp-matched doc → the unpushed edit is stranded). Dirty-before-base means a
    // crash leaves at-worst dirty-WITHOUT-the-new-base, which RECOVERS (catch-up selects the doc;
    // reconcileDirtyDoc merges the disk edit). FIRST-SEEN creates are LEFT UNCHANGED (dirty right after
    // base.save, below) — P1 deliberately does not touch them. NOTE: a SEPARATE, PRE-EXISTING first-seen
    // dirty-orphan wedge exists because `bumpStamp` is DEBOUNCED — the minted docId's live index entry is
    // not durable when markDirty fires, so a crash in the debounce window leaves a dirty docId with no live
    // entry (pendingDocs counts it; catch-up can't reach it). Out of P1's scope; tracked for its own fix.
    if (!firstSeen) await d.engineState.markDirty(docId);
    await d.base.save(docId, {
      baseText: newText,
      fileHash: newHash,
      crdtToken: doc ? doc.encodeStateVector() : null,
      substrate: d.substrate,
      // Carry forward the existing acked base unchanged (an unpushed edit is NOT acked). A
      // first-seen path has no prior record ⇒ nothing is acked yet ⇒ empty acked base.
      ackedText: prior?.ackedText ?? "",
      ackedHash: prior?.ackedHash ?? (await sha256OfText("")),
      // M1b: preserve the durable confirmed-on-disk signal across a fresh-record save.
      materializedHash: prior?.materializedHash,
    });
    // FIRST-SEEN create: mark dirty right after base.save — UNCHANGED from the original ordering (P1 only
    // reorders the existing-doc path). The separate first-seen dirty-orphan is noted above.
    if (firstSeen) await d.engineState.markDirty(docId);

    // 7b. Persist the EDITED CRDT snapshot for an ALREADY-ATTACHED doc (0b-3 crash-window
    //     no-loss). The local edit was applied to the attached doc's Y.Text above, but the
    //     durable docStore snapshot was last written pre-edit; without re-snapshotting, a
    //     restart reloads a PRISTINE doc and the edit lives only on disk+base. Persisting it
    //     here means the reloaded doc CARRIES the edit (and re-pushes it). Only when a doc is
    //     attached and the engine wired the seam; adopt-pending (no doc) has nothing to save.
    if (doc !== undefined && d.persistDocSnapshot !== undefined) {
      await d.persistDocSnapshot(docId, doc);
    }

    // 7a. FIRST-SEEN path (after-start create): seed the doc's create-meta + a docStore
    //     snapshot via the engine seam BEFORE bumping the index. If two devices create
    //     the SAME path concurrently after start, the index LWW binds it to one winner and
    //     the loser docId is orphaned; the orphan sweep recovers the loser ONLY when it can
    //     read the doc's `meta.create` from a docStore snapshot — both written here.
    if (firstSeen && d.onFirstCreate !== undefined) {
      await d.onFirstCreate(docId, path, newText);
    }

    d.bumpStamp(path, docId, "crdt-prose", newHash);

    return result;
  }

  /**
   * Is `docId` bound LIVE at some path OTHER than `exclude`? Used by the rename old-key
   * guard: a tombstone at `exclude` whose docId is live elsewhere is a rename's old key,
   * not a genuine deletion. PURE index read.
   */
  #docIdLiveElsewhere(docId: DocId, exclude: VaultPath): boolean {
    for (const [p, e] of this.#deps.index.liveEntries()) {
      if (e.docId === docId && p !== exclude) return true;
    }
    return false;
  }

  /**
   * Write `newText` back to disk only when it differs from what is already there.
   * `rawDiskText` is the UN-canonicalized on-disk text (NOT the LF-normalized merge input):
   * comparing against the raw form means a CRLF disk file whose canonical content already
   * equals `newText` (LF) is still rewritten to LF — the one-time canonical-LF churn (#35 +
   * hash-identity). INVARIANT: record the echo IMMEDIATELY before the write, always.
   */
  async #writeBackIfChanged(path: VaultPath, rawDiskText: string, newText: string): Promise<void> {
    if (newText === rawDiskText) return;
    this.#deps.echo.recordWrite(path, await sha256OfText(newText));
    await this.#deps.vault.writeAtomic(path, utf8(newText));
  }
}
