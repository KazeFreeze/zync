import { describe, it, expect } from "vitest";
import type { DeviceId, VaultPath } from "../ports.js";
import { sha256OfText } from "../hash.js";
import { EchoLedger } from "../bridge/echo.js";
import { FakeVault } from "../testing/fake-vault.js";
import { conflictArtifactPath, writeConflictArtifact } from "./artifact.js";

const path = (s: string): VaultPath => s as VaultPath;
const DEV_B = "dev-b" as DeviceId;
const TS = "2026-06-11T12-00-00Z";

describe("conflictArtifactPath (deterministic naming)", () => {
  it("inserts the conflict suffix before the last extension", () => {
    expect(conflictArtifactPath(path("notes/a.md"), DEV_B, TS)).toBe(
      "notes/a (conflict, dev-b, 2026-06-11T12-00-00Z).md",
    );
  });

  it("works for an extension-less path (suffix appended, no dot)", () => {
    expect(conflictArtifactPath(path("notes/README"), DEV_B, TS)).toBe(
      "notes/README (conflict, dev-b, 2026-06-11T12-00-00Z)",
    );
  });

  it("uses the LAST dot for the extension (dotted filenames stay intact)", () => {
    expect(conflictArtifactPath(path("a.b.md"), DEV_B, TS)).toBe(
      "a.b (conflict, dev-b, 2026-06-11T12-00-00Z).md",
    );
  });

  it("is deterministic: same inputs → same path on every call (every device agrees)", () => {
    const a = conflictArtifactPath(path("notes/a.md"), DEV_B, TS);
    const b = conflictArtifactPath(path("notes/a.md"), DEV_B, TS);
    expect(a).toBe(b);
  });
});

describe("writeConflictArtifact (echo-recorded + idempotent)", () => {
  it("echo-records the artifact hash BEFORE writing it to disk", async () => {
    const vault = new FakeVault();
    const echo = new EchoLedger();
    const losing = "the losing text";

    const artifactPath = await writeConflictArtifact(
      { vault, echo },
      path("notes/a.md"),
      losing,
      DEV_B,
      TS,
    );

    expect(artifactPath).toBe("notes/a (conflict, dev-b, 2026-06-11T12-00-00Z).md");
    // The artifact bytes are on disk and ARE the losing text.
    const bytes = await vault.read(artifactPath);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe(losing);
    // The write was echo-recorded: the watcher fs event for these bytes is our own.
    const hash = await sha256OfText(losing);
    expect(echo.isEcho(artifactPath, hash)).toBe(true);
  });

  it("is idempotent: a second identical call writes no new bytes (no second fs event)", async () => {
    const vault = new FakeVault();
    const echo = new EchoLedger();
    const losing = "the losing text";

    let writes = 0;
    vault.onEvent(() => {
      writes++;
    });

    await writeConflictArtifact({ vault, echo }, path("notes/a.md"), losing, DEV_B, TS);
    expect(writes).toBe(1);

    // Second identical run: artifact already exists with identical bytes → skip.
    await writeConflictArtifact({ vault, echo }, path("notes/a.md"), losing, DEV_B, TS);
    expect(writes).toBe(1);
  });

  it("rewrites when the existing artifact bytes differ (not a no-op)", async () => {
    const vault = new FakeVault();
    const echo = new EchoLedger();

    let writes = 0;
    vault.onEvent(() => {
      writes++;
    });

    await writeConflictArtifact({ vault, echo }, path("notes/a.md"), "first", DEV_B, TS);
    expect(writes).toBe(1);

    // Same deterministic path but different bytes → a real write happens.
    await writeConflictArtifact({ vault, echo }, path("notes/a.md"), "second", DEV_B, TS);
    expect(writes).toBe(2);
  });
});
