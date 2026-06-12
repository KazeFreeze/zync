import type { DeviceId, DocId, Stamp, VaultPath } from "../ports.js";
import type { BaseStore } from "../bridge/base.js";
import type { EngineStateStore } from "../ports.js";
import { sha256OfText } from "../hash.js";
import { stampHash } from "./stamp.js";

export interface BootstrapInputs {
  hasServerDoc: boolean;
  hasLocalFile: boolean;
  baseExists: boolean;
  localEqualsServer: boolean; // local file's content hash == the index `tree` stamp (0b-2 §B) — NOT a server-projected-text compare (the relay is content-blind)
}
export type BootstrapDecision = "seed" | "adopt-server" | "supervised-import" | "converge" | "none";

/**
 * Genesis/bootstrap decision (design §9.4). The point is to NEVER turn two
 * independent seedings of "the same" note into doubled content: once a base
 * exists we converge normally; with no base we either adopt the server (only
 * when byte-identical or no local file) or route divergence to a supervised
 * import — we never silently merge against an empty base. With neither a server
 * doc nor a local file there is nothing to do → "none" (NEW-7 #6).
 */
export function bootstrapDecision(i: BootstrapInputs): BootstrapDecision {
  if (i.baseExists) return "converge";
  if (!i.hasServerDoc) return i.hasLocalFile ? "seed" : "none";
  if (!i.hasLocalFile) return "adopt-server";
  return i.localEqualsServer ? "adopt-server" : "supervised-import";
}

/** Inputs to {@link applyBootstrap}. Hashes are computed INSIDE the orchestrator (no attach). */
export interface ApplyBootstrapArgs {
  path: VaultPath;
  docId: DocId;
  /** Local file text, or `null` when there is no local file for this path. */
  localText: string | null;
  /** `tree[path].stamp`, or `null` when the server has no doc bound at this path. */
  treeStamp: Stamp | null;
  deviceId: DeviceId;
}

/**
 * The orchestrator's result. `needsAttach` tells the CALLER (engine, Task 13)
 * whether a transport attach is still owed — the orchestrator itself NEVER attaches
 * and NEVER mints a docId.
 */
export interface ApplyBootstrapResult {
  decision: BootstrapDecision;
  needsAttach: boolean;
}

/**
 * Bootstrap ORCHESTRATOR (design §9.4, plan §C). Computes {@link bootstrapDecision}'s
 * inputs from content hashes (NO attach, NO docId minting) and applies the no-attach
 * side effects, signalling via `needsAttach` when an attach is still required.
 *
 * THE DOUBLED-CONTENT LANDMINE GUARD lives here. `localEqualsServer` is computed FROM
 * THE INDEX ALONE — the local file's content hash vs the HASH PART of `tree[path].stamp`
 * (the relay is content-blind, so there is no server-projected text to compare). When a
 * device adopting a never-seen server doc has a BYTE-IDENTICAL local file, it adopts the
 * existing docId with **ZERO attach** (`needsAttach: false`), creates NO second docId,
 * and records the server stamp as already-synced. Two independent seedings of "the same"
 * note therefore never become doubled content.
 *
 * Per-decision side effects:
 * - **seed** (no server doc, local file): save an adopt-pending base
 *   `{ baseText: localText, fileHash, crdtToken: null, substrate }` and `markDirty(docId)`
 *   (lazy-attach re-pushes later). `needsAttach: true`. NO second docId is minted here —
 *   the caller passes the docId; minting a fresh ULID for a first-seen LOCAL-only path is
 *   the CALLER's job (engine, via a ulid seam). `applyBootstrap` NEVER creates a docId.
 * - **adopt-server + byte-identical local** (the landmine guard): save the adopt-pending
 *   base and `setSyncedStamp(docId, treeStamp)`. `needsAttach: FALSE` — zero attach.
 * - **adopt-server + no local file**: `needsAttach: true` — server content must be
 *   materialized via attach; no base is written until then.
 * - **supervised-import**: `needsAttach: true`. NO base merge here — Task 13 attaches,
 *   then calls `supervisedImport` (never a silent merge against an empty base).
 * - **converge**: minimal side effects; `needsAttach` reflects stamp INEQUALITY
 *   (true iff the local hash differs from the tree stamp's hash).
 * - **none**: no-op; `needsAttach: false`.
 */
export async function applyBootstrap(
  deps: {
    base: BaseStore;
    engineState: EngineStateStore;
    /** Whether a base record already exists for this docId (steady-state convergence). */
    baseExists: (docId: DocId) => Promise<boolean>;
    substrate: string;
  },
  args: ApplyBootstrapArgs,
): Promise<ApplyBootstrapResult> {
  const { docId, localText, treeStamp } = args;

  const hasServerDoc = treeStamp !== null;
  const hasLocalFile = localText !== null;
  const baseExists = await deps.baseExists(docId);
  // localEqualsServer compares the LOCAL file hash to the HASH PART of the tree stamp
  // (the index alone — the relay is content-blind). When true, both treeStamp and
  // localText are necessarily non-null (TS narrows them via this `&&`).
  const localEqualsServer =
    treeStamp !== null &&
    localText !== null &&
    (await sha256OfText(localText)) === stampHash(treeStamp);

  const decision = bootstrapDecision({
    hasServerDoc,
    hasLocalFile,
    baseExists,
    localEqualsServer,
  });

  switch (decision) {
    case "seed": {
      // localText is non-null here (decision "seed" ⇒ hasLocalFile). Save adopt-pending
      // base + mark dirty so lazy-attach pushes later. No docId is minted here.
      const text = localText ?? "";
      await deps.base.save(docId, {
        baseText: text,
        fileHash: await sha256OfText(text),
        crdtToken: null,
        substrate: deps.substrate,
      });
      await deps.engineState.markDirty(docId);
      return { decision, needsAttach: true };
    }
    case "adopt-server": {
      // Byte-identical local (the landmine guard): adopt-pending base + synced stamp, ZERO attach.
      // `localEqualsServer` already implies treeStamp/localText are non-null.
      if (localEqualsServer) {
        await deps.base.save(docId, {
          baseText: localText,
          fileHash: await sha256OfText(localText),
          crdtToken: null,
          substrate: deps.substrate,
        });
        await deps.engineState.setSyncedStamp(docId, treeStamp);
        return { decision, needsAttach: false };
      }
      // No local file (or no byte-identical match): server content must be materialized via attach.
      return { decision, needsAttach: true };
    }
    case "supervised-import":
      // No base merge here. Task 13 attaches, then calls supervisedImport.
      return { decision, needsAttach: true };
    case "converge":
      // Steady state: attach iff the tree stamp's hash differs from the local file's hash.
      return { decision, needsAttach: !localEqualsServer };
    case "none":
      return { decision, needsAttach: false };
  }
}
