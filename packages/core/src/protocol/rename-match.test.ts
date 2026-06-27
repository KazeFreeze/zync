import { describe, it, expect } from "vitest";
import { matchRenames } from "./rename-match.js";
import type { DocId, VaultPath } from "../ports.js";

const p = (s: string): VaultPath => s as VaultPath;
const d = (s: string): DocId => s as DocId;
const noGuards = {
  isExcludedPath: () => false,
  isTrivialHash: () => false,
  isLiveElsewhere: () => false,
};

describe("matchRenames", () => {
  it("pairs a lost entry with a created file sharing a unique content hash", () => {
    const r = matchRenames(
      [{ path: p("old.md"), docId: d("doc-1"), hash: "HASH-A" }],
      [{ path: p("new.md"), hash: "HASH-A" }],
      noGuards,
    );
    expect(r.matches).toEqual([{ from: p("old.md"), to: p("new.md"), docId: d("doc-1") }]);
    expect(r.unmatchedLost).toEqual([]);
    expect(r.unmatchedCreated).toEqual([]);
  });

  it("does not match when hashes differ", () => {
    const r = matchRenames(
      [{ path: p("old.md"), docId: d("doc-1"), hash: "HASH-A" }],
      [{ path: p("new.md"), hash: "HASH-B" }],
      noGuards,
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedLost).toHaveLength(1);
    expect(r.unmatchedCreated).toHaveLength(1);
  });

  it("does NOT match when content is duplicated (hash non-unique on either side)", () => {
    const r = matchRenames(
      [
        { path: p("a.md"), docId: d("doc-a"), hash: "DUP" },
        { path: p("b.md"), docId: d("doc-b"), hash: "DUP" },
      ],
      [
        { path: p("x.md"), hash: "DUP" },
        { path: p("y.md"), hash: "DUP" },
      ],
      noGuards,
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedLost).toHaveLength(2);
    expect(r.unmatchedCreated).toHaveLength(2);
  });

  it("does NOT match a trivial (e.g. empty-file) hash even when unique 1:1", () => {
    const r = matchRenames(
      [{ path: p("old-empty.md"), docId: d("doc-1"), hash: "EMPTY" }],
      [{ path: p("new-empty.md"), hash: "EMPTY" }],
      { ...noGuards, isTrivialHash: (h) => h === "EMPTY" },
    );
    expect(r.matches).toEqual([]);
    // a guarded lost entry is NOT silently dropped — it falls through to be materialized (M1a)
    expect(r.unmatchedLost).toHaveLength(1);
    expect(r.unmatchedCreated).toHaveLength(1);
  });

  it("does NOT match into an excluded (temp-file) target path", () => {
    const r = matchRenames(
      [{ path: p("old.md"), docId: d("doc-1"), hash: "HASH-A" }],
      [{ path: p("old.md.tmp.123"), hash: "HASH-A" }],
      { ...noGuards, isExcludedPath: (pp) => pp.includes(".tmp") },
    );
    expect(r.matches).toEqual([]);
    expect(r.unmatchedLost).toHaveLength(1);
  });

  it("does NOT match a hash that is live-elsewhere (a copy of a still-live file)", () => {
    const r = matchRenames(
      [{ path: p("old.md"), docId: d("doc-1"), hash: "HASH-T" }],
      [{ path: p("copy.md"), hash: "HASH-T" }],
      { ...noGuards, isLiveElsewhere: (h) => h === "HASH-T" },
    );
    expect(r.matches).toEqual([]);
    // the lost entry falls through to be materialized (M1a); the copy is a normal new file
    expect(r.unmatchedLost).toHaveLength(1);
    expect(r.unmatchedCreated).toHaveLength(1);
  });
});
