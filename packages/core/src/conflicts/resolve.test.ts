import { describe, it, expect } from "vitest";
import type { VaultPath } from "../ports.js";
import { ArtifactNotLocalError } from "./resolve.js";

describe("ArtifactNotLocalError", () => {
  it("carries the artifact path and a stable name", () => {
    const err = new ArtifactNotLocalError("notes/a (conflict, dev-b, abc1).md" as VaultPath);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ArtifactNotLocalError");
    expect(err.artifactPath).toBe("notes/a (conflict, dev-b, abc1).md");
    expect(err.message).toContain("notes/a (conflict, dev-b, abc1).md");
  });
});
