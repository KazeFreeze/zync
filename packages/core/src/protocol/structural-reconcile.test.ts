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
  deleted: DocId[];
  notices: ResurrectedNotice[];
}

function harness(index: IndexDoc, vault: FakeVault): Harness {
  const dirtied: DocId[] = [];
  const deleted: DocId[] = [];
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
    markDeleted: (id) => {
      deleted.push(id);
      return Promise.resolve();
    },
    onInboxNotice: (n) => {
      notices.push(n);
    },
  };
  return { deps, dirtied, deleted, notices };
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

// ─── S5 EQUIVALENCE: scoped ≡ full when workset covers all docIds ─────────────
//
// CONTRACT: for a workset that covers every docId in the fixture (exactly the
// superset a real engine pass would build), `runStructuralReconcile` with a scope
// must produce BYTE-IDENTICAL outcomes to the unscoped full run — same vault
// mutations (renames + removes in order) and same per-path index state
// (deleted flag + stamp prefix).
//
// The fixture exercises ALL concerns simultaneously in one pass:
//   • RENAME   — doc-rename: old-rename.md tombstoned, new-rename.md live; file at old-rename.md
//   • DELETE   — doc-dead: dead.md tombstoned, disk hash == tombstone hash
//   • RESURRECT— doc-edit: edited.md tombstoned, disk hash ≠ tombstone hash, file present
//   • DIVERGENT— doc-div: div-a.md AND div-b.md both live (concurrent divergent rename)
//   • LIVE     — doc-live1 / doc-live2: untouched live entries (must not be mutated)
//
// The SCOPED run uses workset = every docId in the fixture and allByDocId = the
// tombstone-inclusive docId→paths map (mirrors engine.ts buildWorksetWithMaps).
describe("runStructuralReconcile — S5 scoped ≡ full equivalence", () => {
  /** Vault mutation log: each entry is either a rename or a remove. */
  type VaultOp =
    | { kind: "rename"; from: VaultPath; to: VaultPath }
    | { kind: "remove"; path: VaultPath };

  /** Wrap a FakeVault to record every rename/remove in order. */
  function wrapVault(v: FakeVault): { vault: FakeVault; ops: VaultOp[] } {
    const ops: VaultOp[] = [];
    const origRemove = v.remove.bind(v);
    const origRename = v.rename.bind(v);
    v.remove = (p: VaultPath): Promise<void> => {
      ops.push({ kind: "remove", path: p });
      return origRemove(p);
    };
    v.rename = (from: VaultPath, to: VaultPath): Promise<void> => {
      ops.push({ kind: "rename", from, to });
      return origRename(from, to);
    };
    return { vault: v, ops };
  }

  /**
   * Build ONE independent (vault, index) fixture copy from scratch.
   * Returns the fixture plus the pre-computed workset + allByDocId that the
   * SCOPED run will use — built from the index state before any reconcile runs
   * (mirrors engine.ts buildWorksetWithMaps).
   */
  async function buildFixture(): Promise<{
    vault: FakeVault;
    index: IndexDoc;
    workset: Set<DocId>;
    allByDocId: Map<DocId, VaultPath[]>;
  }> {
    const vault = new FakeVault();
    const index = makeIndex();

    // ── RENAME: doc-rename — old-rename.md tombstoned, new-rename.md live ─────
    const renameDocId = docId("doc-rename");
    // Set new-rename.md live first (the renamed target exists in the index).
    const renameContent = "rename content";
    const renameSha = await sha256OfText(renameContent);
    index.setStamp(path("new-rename.md"), renameDocId, "crdt-prose", renameSha);
    // Tombstone old-rename.md (records the same content hash — bytes unchanged).
    await tombstoneFor(index, path("old-rename.md"), renameDocId, renameContent);
    // File is at OLD path only (target not yet on disk — expects vault.rename).
    await vault.writeAtomic(path("old-rename.md"), utf8(renameContent));

    // ── DELETE: doc-dead — dead.md tombstoned, disk hash == tombstone hash ────
    const deadDocId = docId("doc-dead");
    const deadContent = "doomed body";
    await tombstoneFor(index, path("dead.md"), deadDocId, deadContent);
    await vault.writeAtomic(path("dead.md"), utf8(deadContent));

    // ── RESURRECT: doc-edit — edited.md tombstoned, disk hash ≠ stamp hash ───
    const editDocId = docId("doc-edit");
    await tombstoneFor(index, path("edited.md"), editDocId, "original body");
    // Concurrent edit: different bytes live on disk now.
    await vault.writeAtomic(path("edited.md"), utf8("edited after delete"));

    // ── DIVERGENT RENAME: doc-div — div-a.md AND div-b.md both live ──────────
    const divDocId = docId("doc-div");
    const divSha = await sha256OfText("divergent content");
    index.setStamp(path("div-a.md"), divDocId, "crdt-prose", divSha);
    index.setStamp(path("div-b.md"), divDocId, "crdt-prose", divSha);
    // Both files materialized on disk.
    await vault.writeAtomic(path("div-a.md"), utf8("divergent content"));
    await vault.writeAtomic(path("div-b.md"), utf8("divergent content"));

    // ── LIVE: doc-live1, doc-live2 — untouched ────────────────────────────────
    const live1Sha = await sha256OfText("live1 content");
    const live2Sha = await sha256OfText("live2 content");
    index.setStamp(path("live1.md"), docId("doc-live1"), "crdt-prose", live1Sha);
    index.setStamp(path("live2.md"), docId("doc-live2"), "crdt-prose", live2Sha);
    await vault.writeAtomic(path("live1.md"), utf8("live1 content"));
    await vault.writeAtomic(path("live2.md"), utf8("live2 content"));

    // ── Build workset + allByDocId (mirrors engine.ts buildWorksetWithMaps) ───
    const workset = new Set<DocId>();
    const allByDocId = new Map<DocId, VaultPath[]>();
    for (const [p, entry] of index.entries()) {
      if (entry.docId === "") continue;
      workset.add(entry.docId);
      const existing = allByDocId.get(entry.docId);
      if (existing === undefined) {
        allByDocId.set(entry.docId, [p]);
      } else {
        existing.push(p);
      }
    }

    return { vault, index, workset, allByDocId };
  }

  /** Snapshot the full index state (every path → { deleted, stampPrefix }) for comparison. */
  function snapshotIndex(index: IndexDoc): Map<string, { deleted: boolean; stampPrefix: string }> {
    const snap = new Map<string, { deleted: boolean; stampPrefix: string }>();
    for (const [p, entry] of index.entries()) {
      snap.set(p, {
        deleted: entry.deleted === true,
        // Use the first 64 chars of the stamp (the sha256 hash part) to compare content identity
        // without comparing device suffixes which differ between independent index instances.
        stampPrefix: entry.stamp.slice(0, 64),
      });
    }
    return snap;
  }

  it("SCOPED (workset = all docIds) produces IDENTICAL vault ops + index state as FULL", async () => {
    // ── Run A: FULL — no scope ────────────────────────────────────────────────
    const fixtureA = await buildFixture();
    const { vault: vaultA, ops: opsA } = wrapVault(fixtureA.vault);
    const dirtyA: DocId[] = [];
    const noticesA: ResurrectedNotice[] = [];
    const depsA: StructuralReconcileDeps = {
      index: fixtureA.index,
      vault: vaultA,
      localHashOf: async (p) => {
        const bytes = await vaultA.read(p);
        return bytes === null ? null : await sha256OfBytes(bytes);
      },
      markDirty: (id) => {
        dirtyA.push(id);
        return Promise.resolve();
      },
      markDeleted: () => Promise.resolve(),
      onInboxNotice: (n) => {
        noticesA.push(n);
      },
      // confirmDivergence: omitted → resolves immediately (single-pass settled index)
    };
    await runStructuralReconcile(depsA);

    // ── Run B: SCOPED — workset = all docIds, allByDocId = tombstone-inclusive ─
    const fixtureB = await buildFixture();
    const { vault: vaultB, ops: opsB } = wrapVault(fixtureB.vault);
    const dirtyB: DocId[] = [];
    const noticesB: ResurrectedNotice[] = [];
    const depsB: StructuralReconcileDeps = {
      index: fixtureB.index,
      vault: vaultB,
      localHashOf: async (p) => {
        const bytes = await vaultB.read(p);
        return bytes === null ? null : await sha256OfBytes(bytes);
      },
      markDirty: (id) => {
        dirtyB.push(id);
        return Promise.resolve();
      },
      markDeleted: () => Promise.resolve(),
      onInboxNotice: (n) => {
        noticesB.push(n);
      },
      scope: {
        workset: fixtureB.workset,
        allByDocId: fixtureB.allByDocId,
      },
    };
    await runStructuralReconcile(depsB);

    // ── Assert equivalence ────────────────────────────────────────────────────

    // Vault mutation sequences must match (same ops, same order).
    expect(opsB).toEqual(opsA);

    // markDirty calls (resurrected docIds) must match (order-independent set).
    expect(new Set(dirtyB)).toEqual(new Set(dirtyA));

    // Inbox notices must match (order-independent set of paths).
    const noticePathsA = new Set(noticesA.map((n) => n.path));
    const noticePathsB = new Set(noticesB.map((n) => n.path));
    expect(noticePathsB).toEqual(noticePathsA);

    // Full index state (every path's deleted flag + stamp hash prefix) must match.
    const snapA = snapshotIndex(fixtureA.index);
    const snapB = snapshotIndex(fixtureB.index);
    expect(snapB).toEqual(snapA);

    // Sanity: the run actually did something (not an inert all-live fixture).
    // The rename op must be present; the dead.md remove must be present.
    expect(opsA.some((op) => op.kind === "rename")).toBe(true);
    expect(opsA.some((op) => op.kind === "remove" && op.path === path("dead.md"))).toBe(true);
    // doc-edit must have been dirtied (resurrection).
    expect(dirtyA).toContain(docId("doc-edit"));
  });
});
