import { describe, it, expect } from "vitest";
import type { DeviceId, DocId, VaultPath } from "../ports.js";
import { sha256OfText } from "../hash.js";
import { EchoLedger } from "../bridge/echo.js";
import { BaseStore } from "../bridge/base.js";
import { FakeVault } from "../testing/fake-vault.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { Inbox, type InboxEntry } from "./inbox.js";
import { supervisedImport } from "./supervised-import.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const DEV_B = "dev-b" as DeviceId;
const TS = "2026-06-11T12-00-00Z";
const SUBSTRATE = "yjs";

function harness() {
  const vault = new FakeVault();
  const echo = new EchoLedger();
  const base = new BaseStore(vault, ".obsidian");
  const inbox = new Inbox(new FakeCrdtMap<InboxEntry>());
  return { vault, echo, base, inbox };
}

const NOTE = path("notes/a.md");
const DOC = docId("doc-a");
const LOCAL = "my local edits\nthat diverge";
const SERVER = "the server's authoritative text";

describe("supervisedImport (divergent bootstrap — adopt server, park local, NO silent merge)", () => {
  it("adopts the SERVER text as the live note byte-for-byte (never a 3-way blend)", async () => {
    const h = harness();
    await supervisedImport(
      { ...h, substrate: SUBSTRATE },
      { path: NOTE, docId: DOC, localText: LOCAL, serverText: SERVER, deviceId: DEV_B, ts: TS },
    );

    const live = await h.vault.read(NOTE);
    expect(live).not.toBeNull();
    const liveText = new TextDecoder().decode(live ?? new Uint8Array());
    // The live note is EXACTLY the server text — no local content leaked in.
    expect(liveText).toBe(SERVER);
    expect(liveText).not.toContain("local edits");
  });

  it("writes the base from serverText with crdtToken null (adopt-pending)", async () => {
    const h = harness();
    await supervisedImport(
      { ...h, substrate: SUBSTRATE },
      { path: NOTE, docId: DOC, localText: LOCAL, serverText: SERVER, deviceId: DEV_B, ts: TS },
    );

    const rec = await h.base.load(DOC);
    expect(rec).not.toBeNull();
    expect(rec?.baseText).toBe(SERVER);
    expect(rec?.fileHash).toBe(await sha256OfText(SERVER));
    expect(rec?.crdtToken).toBeNull();
    expect(rec?.substrate).toBe(SUBSTRATE);
  });

  it("parks the LOCAL text in a deterministic conflict artifact", async () => {
    const h = harness();
    const { artifactPath } = await supervisedImport(
      { ...h, substrate: SUBSTRATE },
      { path: NOTE, docId: DOC, localText: LOCAL, serverText: SERVER, deviceId: DEV_B, ts: TS },
    );

    expect(artifactPath).toBe("_conflicts/notes/a (conflict, dev-b, 2026-06-11T12-00-00Z).md");
    const bytes = await h.vault.read(artifactPath);
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe(LOCAL);
  });

  it("adds EXACTLY ONE inbox entry of kind 'supervised-import' pointing at the artifact", async () => {
    const h = harness();
    const { artifactPath } = await supervisedImport(
      { ...h, substrate: SUBSTRATE },
      { path: NOTE, docId: DOC, localText: LOCAL, serverText: SERVER, deviceId: DEV_B, ts: TS },
    );

    const entries = h.inbox.list();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    if (e === undefined) throw new Error("expected one inbox entry");
    expect(e.kind).toBe("supervised-import");
    expect(e.path).toBe(NOTE);
    expect(e.docId).toBe(DOC);
    expect(e.artifactPath).toBe(artifactPath);
    expect(e.id).toBe(`supervised-import:notes/a.md:${(await sha256OfText(LOCAL)).slice(0, 8)}`);
  });

  it("echo-records the live-note write (our own write-back is not re-ingested)", async () => {
    const h = harness();
    await supervisedImport(
      { ...h, substrate: SUBSTRATE },
      { path: NOTE, docId: DOC, localText: LOCAL, serverText: SERVER, deviceId: DEV_B, ts: TS },
    );
    expect(h.echo.isEcho(NOTE, await sha256OfText(SERVER))).toBe(true);
  });
});
