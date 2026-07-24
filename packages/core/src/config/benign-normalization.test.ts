import { describe, it, expect } from "vitest";
import { isBenignSuperset, deepEqual } from "./benign-normalization.js";

const NONE = new Set<string>();
const NOISY = new Set<string>(["lastRun"]);

describe("deepEqual", () => {
  it("objects are order-insensitive; arrays order-sensitive", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: [1, { x: 2 }] }, { a: [1, { x: 2 }] })).toBe(true);
    expect(deepEqual(1, "1")).toBe(false);
  });
});

describe("isBenignSuperset", () => {
  it("identical → benign", () => {
    expect(isBenignSuperset({ a: 1 }, { a: 1 }, NONE)).toBe(true);
  });
  it("local ADDS a key → benign (default-fill)", () => {
    expect(isBenignSuperset({ a: 1 }, { a: 1, b: 2 }, NONE)).toBe(true);
  });
  it("reordered keys → benign", () => {
    expect(isBenignSuperset({ a: 1, b: 2 }, { b: 2, a: 1 }, NONE)).toBe(true);
  });
  it("changed existing scalar → NOT benign (user edit)", () => {
    expect(isBenignSuperset({ a: 1 }, { a: 9 }, NONE)).toBe(false);
  });
  it("removed key → NOT benign", () => {
    expect(isBenignSuperset({ a: 1, b: 2 }, { a: 1 }, NONE)).toBe(false);
  });
  it("nested added key → benign; nested changed value → not", () => {
    expect(isBenignSuperset({ o: { a: 1 } }, { o: { a: 1, b: 2 } }, NONE)).toBe(true);
    expect(isBenignSuperset({ o: { a: 1 } }, { o: { a: 2 } }, NONE)).toBe(false);
  });
  it("array element change/add → NOT benign", () => {
    expect(isBenignSuperset({ a: [1, 2] }, { a: [1, 3] }, NONE)).toBe(false);
    expect(isBenignSuperset({ a: [1] }, { a: [1, 2] }, NONE)).toBe(false);
  });
  it("noisy-key-only difference → benign (ignored)", () => {
    expect(isBenignSuperset({ lastRun: 1, a: 1 }, { lastRun: 999, a: 1 }, NOISY)).toBe(true);
  });
  it("type mismatch (object vs array) → NOT benign", () => {
    expect(isBenignSuperset({ a: {} }, { a: [] }, NONE)).toBe(false);
  });
});
