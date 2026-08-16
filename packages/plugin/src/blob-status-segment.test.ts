import { describe, it, expect } from "vitest";
import { blobStatusSegment, type BlobProgressInputs } from "./blob-status-segment.js";

const inputs = (over: Partial<BlobProgressInputs> = {}): BlobProgressInputs => ({
  total: 10,
  materialized: 3,
  failed: 0,
  written: 0,
  settled: false,
  ...over,
});

describe("blobStatusSegment", () => {
  /**
   * Eager start on an already-synced vault re-verifies every advertised blob. `materialized`
   * climbs while `written` stays 0 — that must NOT read as "Files x/y" (a claim that bytes moved).
   */
  it("labels verification-only progress as Checking, not Files", () => {
    const seg = blobStatusSegment(inputs({ written: 0, materialized: 3, total: 10 }));
    expect(seg).not.toBeNull();
    expect(seg?.text).toMatch(/^Checking 3\/10$/);
    expect(seg?.text).not.toMatch(/Files/);
    expect(seg?.icon).toBe("search");
  });

  it("uses Files wording only when at least one blob was actually written", () => {
    const seg = blobStatusSegment(inputs({ written: 1, materialized: 3, total: 10 }));
    expect(seg).toEqual({
      icon: "download",
      text: "Files 3/10",
      failed: 0,
    });
  });

  it("keeps the failed count for genuine parked failures", () => {
    const seg = blobStatusSegment(inputs({ written: 2, materialized: 4, total: 10, failed: 2 }));
    expect(seg?.text).toBe("Files 4/10 (2 failed)");
    expect(seg?.failed).toBe(2);
  });

  it("is absent once settled or fully materialized", () => {
    expect(blobStatusSegment(inputs({ settled: true, written: 5 }))).toBeNull();
    expect(blobStatusSegment(inputs({ materialized: 10, total: 10, written: 5 }))).toBeNull();
  });

  it("is absent when there is nothing to report", () => {
    expect(blobStatusSegment(inputs({ total: 0 }))).toBeNull();
  });
});
