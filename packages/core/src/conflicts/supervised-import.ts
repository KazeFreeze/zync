import type { DeviceId, DocId, VaultPath, VaultPort } from "../ports.js";
import { sha256OfText } from "../hash.js";
import type { EchoLedger } from "../bridge/echo.js";
import type { BaseStore } from "../bridge/base.js";
import { writeConflictArtifact } from "./artifact.js";
import type { Inbox } from "./inbox.js";

/**
 * The divergent-bootstrap handler (`bootstrapDecision === "supervised-import"`:
 * the server doc EXISTS, there is NO base, and local content DIFFERS from server).
 *
 * THE RULE: never silently merge against an empty base. A `merge3("", local, server)`
 * over an empty base would invent a blended note that matches NEITHER side — silent
 * data corruption. Instead we treat it as a human-supervised import:
 *
 *   1. ADOPT the server text as the live note (it is the shared truth) — echo-record
 *      then write; save base `{ baseText: serverText, crdtToken: null }` (adopt-pending,
 *      base BEFORE file so a torn pair recovers safely).
 *   2. PARK the local text as a deterministic conflict artifact (nothing lost).
 *   3. SURFACE one inbox entry so the user can reconcile the parked local copy.
 *
 * Zero `merge3` calls: this module does not import or call the 3-way merge — proven
 * structurally (no `merge` import here) and behaviourally (the live note is
 * byte-for-byte `serverText` in the test).
 */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export async function supervisedImport(
  deps: {
    vault: VaultPort;
    echo: EchoLedger;
    base: BaseStore;
    inbox: Inbox;
    substrate: string;
  },
  args: {
    path: VaultPath;
    docId: DocId;
    localText: string;
    serverText: string;
    deviceId: DeviceId;
    ts: string;
  },
): Promise<{ artifactPath: VaultPath }> {
  const { vault, echo, base, inbox, substrate } = deps;
  const { path, docId, localText, serverText, deviceId, ts } = args;

  // 1. Adopt the server text as the live note. Base BEFORE file (torn-pair safe);
  //    echo-record IMMEDIATELY before the note write.
  const serverHash = await sha256OfText(serverText);
  await base.save(docId, {
    baseText: serverText,
    fileHash: serverHash,
    crdtToken: null, // adopt-pending: no CRDT side attached yet
    substrate,
    // The adopted content came FROM the server, so it is relay-acked — both bases advance.
    ackedText: serverText,
    ackedHash: serverHash,
  });
  echo.recordWrite(path, serverHash);
  await vault.writeAtomic(path, utf8(serverText));

  // 2. Park the local (divergent) text as a deterministic conflict artifact.
  const artifactPath = await writeConflictArtifact({ vault, echo }, path, localText, deviceId, ts);

  // 3. Surface ONE inbox entry. The id is deterministic (kind:path:localHash8) so the
  //    same divergence does not duplicate across devices after sync.
  const localHash8 = (await sha256OfText(localText)).slice(0, 8);
  inbox.add({
    id: `supervised-import:${path}:${localHash8}`,
    kind: "supervised-import",
    path,
    docId,
    artifactPath,
    detail: `Imported server copy of ${path}; your local copy was kept as ${artifactPath}.`,
  });

  return { artifactPath };
}
