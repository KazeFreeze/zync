import { describe, it, expect } from "vitest";
import type { DeviceId, DocId, Sha256, VaultPath } from "../ports.js";
import { FakeVault } from "../testing/fake-vault.js";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { sha256OfBytes, sha256OfText } from "../hash.js";
import { IndexDoc, type TreeEntry } from "./index-doc.js";
import { recordTombstone, type ResurrectedNotice } from "../bridge/tombstone.js";
import { runStructuralReconcile, type StructuralReconcileDeps } from "./structural-reconcile.js";

const path = (s: string): VaultPath => s as VaultPath;
const docId = (s: string): DocId => s as DocId;
const DEVICE = "dev-1" as DeviceId;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function makeIndex(): IndexDoc {
  return new IndexDoc(new FakeCrdtMap<TreeEntry>(), DEVICE);
}

/** Spy seams over a real vault+index; captures markDirty/inbox so tests can assert. */
interface Harness {
  deps: StructuralReconcileDeps;
  dirtied: DocId[];
  notices: ResurrectedNotice[];
}

function harness(index: IndexDoc, vault: FakeVault): Harness {
  const dirtied: DocId[] = [];
  const notices: ResurrectedNotice[] = [];
  const deps: StructuralReconcileDeps = {
    index,
    vault,
    localHashOf: async (p) => {
      const bytes = await vault.read(p);
      return bytes === null ? null : await sha256OfBytes(bytes);
    },
    markDirty: (id) => {
      dirtied.push(id);
      return Promise.resolve();
    },
    onInboxNotice: (n) => {
      notices.push(n);
    },
  };
  return { deps, dirtied, notices };
}

/** Lay an uncontested tombstone at `path` whose stamp hash == sha256(content). */
async function tombstoneFor(
  index: IndexDoc,
  p: VaultPath,
  id: DocId,
  content: string,
): Promise<Sha256> {
  const sha = await sha256OfText(content);
  recordTombstone(index, p, id, "crdt-prose", DEVICE, sha);
  return sha;
}

describe("runStructuralReconcile — inbound tombstone → vault.remove (C1, delete concern)", () => {
  it("UNCONTESTED tombstone + local file whose hash matches → vault.remove once", async () => {
    const vault = new FakeVault();
    const index = makeIndex();
    await vault.writeAtomic(path("a.md"), utf8("doomed body"));
    await tombstoneFor(index, path("a.md"), docId("doc-a"), "doomed body");

    let removed = 0;
    const origRemove = vault.remove.bind(vault);
    vault.remove = (p: VaultPath): Promise<void> => {
      removed += 1;
      return origRemove(p);
    };

    await runStructuralReconcile(harness(index, vault).deps);

    expect(removed).toBe(1);
    expect(await vault.read(path("a.md"))).toBeNull();
  });

  it("tombstone with NO file on disk → no-op (nothing to remove)", async () => {
    const vault = new FakeVault();
    const index = makeIndex();
    await tombstoneFor(index, path("gone.md"), docId("doc-g"), "whatever");

    let removed = 0;
    const origRemove = vault.remove.bind(vault);
    vault.remove = (p: VaultPath): Promise<void> => {
      removed += 1;
      return origRemove(p);
    };

    await runStructuralReconcile(harness(index, vault).deps);

    expect(removed).toBe(0);
  });

  it("CONTESTED tombstone (disk hash ≠ stamp hash) → RESURRECT (C3): file kept, entry re-listed LIVE at disk hash, markDirty + inbox notice", async () => {
    const vault = new FakeVault();
    const index = makeIndex();
    // Tombstone remembers the hash of "old body"; disk now holds a concurrent edit.
    await tombstoneFor(index, path("c.md"), docId("doc-c"), "old body");
    await vault.writeAtomic(path("c.md"), utf8("edited after delete"));
    const editedSha = await sha256OfText("edited after delete");

    const h = harness(index, vault);
    await runStructuralReconcile(h.deps);

    // The concurrently-edited file survives.
    expect(await vault.read(path("c.md"))).not.toBeNull();
    // The entry is re-listed LIVE at the disk content hash, same docId/type.
    const entry = index.get(path("c.md"));
    expect(entry?.deleted).not.toBe(true);
    expect(entry?.docId).toBe(docId("doc-c"));
    expect(entry?.type).toBe("crdt-prose");
    expect(entry?.stamp.startsWith(editedSha)).toBe(true);
    // The resurrecting device owes a re-push; an inbox notice is surfaced.
    expect(h.dirtied).toEqual([docId("doc-c")]);
    expect(h.notices).toEqual([{ kind: "resurrected", path: path("c.md"), docId: docId("doc-c") }]);
  });

  it("RESURRECT is idempotent: a second run sees a LIVE entry → no-op (no re-dirty, no re-notice)", async () => {
    const vault = new FakeVault();
    const index = makeIndex();
    await tombstoneFor(index, path("c.md"), docId("doc-c"), "old body");
    await vault.writeAtomic(path("c.md"), utf8("edited after delete"));

    await runStructuralReconcile(harness(index, vault).deps);

    // Second run: the entry is LIVE now, so resurrection must be a no-op.
    const h2 = harness(index, vault);
    await runStructuralReconcile(h2.deps);
    expect(h2.dirtied).toEqual([]);
    expect(h2.notices).toEqual([]);
    expect(await vault.read(path("c.md"))).not.toBeNull();
  });

  it("idempotent: a second run after the file is gone removes nothing", async () => {
    const vault = new FakeVault();
    const index = makeIndex();
    await vault.writeAtomic(path("a.md"), utf8("doomed body"));
    await tombstoneFor(index, path("a.md"), docId("doc-a"), "doomed body");

    await runStructuralReconcile(harness(index, vault).deps);
    expect(await vault.read(path("a.md"))).toBeNull();

    let removed = 0;
    const origRemove = vault.remove.bind(vault);
    vault.remove = (p: VaultPath): Promise<void> => {
      removed += 1;
      return origRemove(p);
    };
    await runStructuralReconcile(harness(index, vault).deps);
    expect(removed).toBe(0);
  });

  it("does NOT touch a LIVE (non-tombstoned) entry's file", async () => {
    const vault = new FakeVault();
    const index = makeIndex();
    await vault.writeAtomic(path("live.md"), utf8("alive"));
    index.setStamp(path("live.md"), docId("doc-l"), "crdt-prose", await sha256OfText("alive"));

    await runStructuralReconcile(harness(index, vault).deps);

    expect(await vault.read(path("live.md"))).not.toBeNull();
  });
});
