import { describe, it, expect } from "vitest";
import { BlobTransientError, BlobNotFoundError, BlobPermanentError } from "./errors.js";

describe("blob error taxonomy", () => {
  it("each carries name + sha and is an Error", () => {
    const t = new BlobTransientError({ sha: "abc" as never, cause: "503" });
    const n = new BlobNotFoundError({ sha: "abc" as never });
    const p = new BlobPermanentError({ sha: "abc" as never, reason: "413 too large" });
    expect(t).toBeInstanceOf(Error);
    expect([t.name, n.name, p.name]).toEqual([
      "BlobTransientError",
      "BlobNotFoundError",
      "BlobPermanentError",
    ]);
    expect(t.sha).toBe("abc");
    expect(p.reason).toBe("413 too large");
  });
});
