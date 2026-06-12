import { describe, it, expect } from "vitest";
import { diffToEdits, merge3, applyEdits } from "./merge.js";

describe("diffToEdits", () => {
  it("produces positional splices (never whole replace)", () => {
    const edits = diffToEdits("hello world", "hello brave world");
    expect(edits).toEqual([{ at: 6, delete: 0, insert: "brave " }]);
    expect(applyEdits("hello world", edits)).toBe("hello brave world");
  });
  it("represents a deletion as delete>0 insert=''", () => {
    const edits = diffToEdits("abcdef", "abef");
    expect(applyEdits("abcdef", edits)).toBe("abef");
  });
});

describe("merge3", () => {
  const base = "line1\nline2\nline3\n";
  it("only disk changed → take disk", () => {
    const r = merge3(base, "line1\nDISK\nline3\n", base);
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("line1\nDISK\nline3\n");
  });
  it("only crdt changed → take crdt", () => {
    const r = merge3(base, base, "line1\nCRDT\nline3\n");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("line1\nCRDT\nline3\n");
  });
  it("disjoint line edits both sides → clean merge of both", () => {
    const r = merge3(base, "DISK\nline2\nline3\n", "line1\nline2\nCRDT\n");
    expect(r.clean).toBe(true);
    expect(r.merged).toBe("DISK\nline2\nCRDT\n");
  });
  it("overlapping same-line edits → unclean", () => {
    const r = merge3(base, "line1\nDISK\nline3\n", "line1\nCRDT\nline3\n");
    expect(r.clean).toBe(false);
  });
});
