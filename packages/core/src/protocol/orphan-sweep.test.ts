import { describe, it, expect } from "vitest";
import {
  findOrphans,
  orphanRecoveryPath,
  recoverOrphan,
  orphanSweep,
  type OrphanMeta,
} from "./orphan-sweep.js";
import { IndexDoc, type TreeEntry } from "./index-doc.js";
import { BaseStore } from "../bridge/base.js";
import { EchoLedger } from "../bridge/echo.js";
import { Inbox, type InboxEntry } from "../conflicts/inbox.js";
import { sha256OfText } from "../hash.js";
import { stampHash } from "./stamp.js";
import { FakeVault } from "../testing/fake-vault.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import type { DeviceId, DocId, VaultPath, VaultEvent } from "../ports.js";
import type { Route } from "../classify/classify.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const DEVICE = "dev-a" as DeviceId;
const SUBSTRATE = "yjs-v1";

function buildIndex(): IndexDoc {
  return new IndexDoc(new FakeCrdtMap<TreeEntry>(), DEVICE);
}

function deps(): {
  vault: FakeVault;
  echo: EchoLedger;
  index: IndexDoc;
  inbox: Inbox;
  base: BaseStore;
  substrate: string;
} {
  const vault = new FakeVault();
  return {
    vault,
    echo: new EchoLedger(),
    index: buildIndex(),
    inbox: new Inbox(new FakeCrdtMap<InboxEntry>()),
    base: new BaseStore(vault, ".obsidian"),
    substrate: SUBSTRATE,
  };
}

describe("findOrphans (docIds in the doc-set but not bound by any LIVE tree entry)", () => {
  it("returns a docId present in the doc-set but unreferenced by the tree", async () => {
    const index = buildIndex();
    index.setStamp(path("a.md"), docId("bound"), "crdt-prose", await sha256OfText("a"));

    const orphans = findOrphans(index, [docId("bound"), docId("orphan")]);
    expect(orphans).toEqual([docId("orphan")]);
  });

  it("a bound docId is NOT an orphan", async () => {
    const index = buildIndex();
    index.setStamp(path("a.md"), docId("bound"), "crdt-prose", await sha256OfText("a"));

    expect(findOrphans(index, [docId("bound")])).toEqual([]);
  });

  it("a docId bound ONLY by a tombstone (not a live entry) IS an orphan", async () => {
    const index = buildIndex();
    index.setStamp(path("a.md"), docId("d1"), "crdt-prose", await sha256OfText("a"));
    index.delete(path("a.md")); // tombstone — no longer a live binding

    expect(findOrphans(index, [docId("d1")])).toEqual([docId("d1")]);
  });
});

describe("orphanRecoveryPath (deterministic — all devices compute the same name)", () => {
  it("derives 'x/a.md' → 'x/a (conflict, <createdBy>, <createdTs>).md' from create-metadata", () => {
    const meta: OrphanMeta = {
      createdBy: "dev-b" as DeviceId,
      createdTs: "2026-06-11T12-00-00Z",
      originalPath: path("x/a.md"),
    };
    expect(orphanRecoveryPath(meta)).toBe("x/a (conflict, dev-b, 2026-06-11T12-00-00Z).md");
  });

  it("is a pure function of create-metadata (identical meta → identical path)", () => {
    const meta: OrphanMeta = {
      createdBy: "dev-c" as DeviceId,
      createdTs: "2026-06-11T09-30-00Z",
      originalPath: path("daily.md"),
    };
    expect(orphanRecoveryPath(meta)).toBe(orphanRecoveryPath({ ...meta }));
  });
});

describe("recoverOrphan (bind path→docId reusing the orphan id, write file, inbox entry)", () => {
  it("binds the deterministic path to the SAME orphan docId, writes the file, adds one inbox entry", async () => {
    const d = deps();
    const id = docId("orphan-1");
    const meta: OrphanMeta = {
      createdBy: "dev-b" as DeviceId,
      createdTs: "2026-06-11T12-00-00Z",
      originalPath: path("notes/daily.md"),
    };

    const { path: recovered } = await recoverOrphan(d, {
      docId: id,
      text: "orphan content",
      type: "crdt-prose",
      meta,
    });

    expect(recovered).toBe("notes/daily (conflict, dev-b, 2026-06-11T12-00-00Z).md");

    // Tree binds the recovered path to the REUSED orphan docId (no new create).
    const entry = d.index.get(recovered);
    expect(entry?.docId).toBe(id);
    expect(entry?.type).toBe("crdt-prose");
    expect(stampHash(entry?.stamp ?? "")).toBe(await sha256OfText("orphan content"));

    // File written with the orphan's text.
    const onDisk = await d.vault.read(recovered);
    expect(onDisk).not.toBeNull();
    expect(new TextDecoder().decode(onDisk ?? new Uint8Array())).toBe("orphan content");

    // Base saved (adopt-pending).
    const rec = await d.base.load(id);
    expect(rec?.baseText).toBe("orphan content");
    expect(rec?.crdtToken).toBeNull();

    // Exactly one inbox entry surfaced.
    expect(d.inbox.list()).toHaveLength(1);
    const inboxEntry = d.inbox.list()[0];
    expect(inboxEntry?.kind).toBe("conflict");
    expect(inboxEntry?.path).toBe(recovered);
    expect(inboxEntry?.docId).toBe(id);
  });

  it("is IDEMPOTENT: running it twice produces no duplicate inbox entry and no second write event", async () => {
    const d = deps();
    const id = docId("orphan-2");
    const meta: OrphanMeta = {
      createdBy: "dev-b" as DeviceId,
      createdTs: "2026-06-11T12-00-00Z",
      originalPath: path("x.md"),
    };

    // Count fs write events AFTER the first recovery so the second run can be asserted no-op.
    const events: VaultEvent[] = [];

    const first = await recoverOrphan(d, { docId: id, text: "v1", type: "crdt-prose", meta });

    d.vault.onEvent((e) => events.push(e));
    const second = await recoverOrphan(d, { docId: id, text: "v1", type: "crdt-prose", meta });

    expect(second.path).toBe(first.path);
    // No second write event — re-writing identical bytes is suppressed.
    expect(events).toHaveLength(0);
    // No duplicate inbox entry (deterministic id → single LWW key).
    expect(d.inbox.list()).toHaveLength(1);
    // Tree still binds the SAME single docId at the recovered path.
    expect(d.index.get(first.path)?.docId).toBe(id);
  });
});

describe("orphanSweep (recover all orphans; idempotent across runs)", () => {
  it("recovers every orphan to its deterministic path; bound docIds are untouched", async () => {
    const d = deps();
    // 'a.md' is bound to 'bound'. 'orphan-x' is in the doc-set but unbound.
    d.index.setStamp(path("a.md"), docId("bound"), "crdt-prose", await sha256OfText("a"));

    const orphanText = "orphaned daily content";
    const meta: OrphanMeta = {
      createdBy: "dev-c" as DeviceId,
      createdTs: "2026-06-11T08-00-00Z",
      originalPath: path("daily.md"),
    };

    const data: Record<string, { text: string; type: Route; meta: OrphanMeta }> = {
      "orphan-x": { text: orphanText, type: "crdt-prose", meta },
    };

    const result = await orphanSweep(d, {
      index: d.index,
      docSet: [docId("bound"), docId("orphan-x")],
      orphanData: (id) => Promise.resolve(data[id] ?? { text: "", type: "excluded", meta }),
    });

    expect(result.recovered).toEqual([
      { docId: docId("orphan-x"), path: path("daily (conflict, dev-c, 2026-06-11T08-00-00Z).md") },
    ]);
    expect(d.index.get(path("daily (conflict, dev-c, 2026-06-11T08-00-00Z).md"))?.docId).toBe(
      docId("orphan-x"),
    );
  });

  it("is IDEMPOTENT across runs: a second sweep recovers the SAME paths, no duplicates", async () => {
    const d = deps();
    const meta: OrphanMeta = {
      createdBy: "dev-c" as DeviceId,
      createdTs: "2026-06-11T08-00-00Z",
      originalPath: path("daily.md"),
    };
    const data: Record<string, { text: string; type: Route; meta: OrphanMeta }> = {
      "orphan-x": { text: "content", type: "crdt-prose", meta },
    };
    const orphanData = (
      id: DocId,
    ): Promise<{ text: string; type: Route; meta: OrphanMeta } | null> =>
      Promise.resolve(data[id] ?? { text: "", type: "excluded", meta });
    const args = { index: d.index, docSet: [docId("orphan-x")], orphanData };

    const first = await orphanSweep(d, args);

    // After the first sweep the orphan is bound, so the second sweep finds NOTHING to recover.
    const second = await orphanSweep(d, args);

    expect(first.recovered).toHaveLength(1);
    expect(second.recovered).toHaveLength(0);
    expect(d.inbox.list()).toHaveLength(1);
  });

  it("SKIPS an orphan whose data is null (not THIS device's — the owner recovers it)", async () => {
    const d = deps();

    const result = await orphanSweep(d, {
      index: d.index,
      docSet: [docId("not-ours")],
      // `null` ⇒ this device does not own the orphan's snapshot; the owner recovers it.
      orphanData: () => Promise.resolve(null),
    });

    expect(result.recovered).toHaveLength(0);
    expect(d.index.entries()).toHaveLength(0);
    expect(d.inbox.list()).toHaveLength(0);
  });
});
