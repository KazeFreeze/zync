import { describe, it, expect } from "vitest";
import { stuckCopy } from "./stuck-copy.js";

const absent = (path: string) => ({ path, onDisk: false });
const present = (path: string) => ({ path, onDisk: true });
const untracked = { path: null, onDisk: false };

describe("stuckCopy", () => {
  it("never-arrived: does NOT claim attempts were made, nor that reconnecting helps", () => {
    // The bug this guards: generic copy said "stopped syncing after repeated attempts. Reconnecting
    // may clear this." Both are FALSE here (this device had nothing to send, and the content source
    // is gone), and promising a remedy that cannot work is worse than saying nothing.
    const { sub, fix } = stuckCopy([absent("test 2.md")]);
    expect(sub).not.toMatch(/attempt/i);
    expect(sub).not.toMatch(/reconnect/i);
    expect(sub).toContain("never arrived");
    expect(sub).toContain("nothing here to lose");
    expect(fix).not.toBeNull();
  });

  it("never-arrived fix: the SAFE branch is stated before the destructive one, with its consequence", () => {
    const { fix } = stuckCopy([absent("test 2.md")]);
    const text = fix ?? "";
    const safeAt = text.indexOf("still has this note");
    const destructiveAt = text.indexOf("create a note");
    expect(safeAt).toBeGreaterThan(-1);
    expect(destructiveAt).toBeGreaterThan(safeAt); // fork order: verify-first, then act
    expect(text).toContain("would delete it there"); // the consequence gives the gate teeth
  });

  it("on-disk: reassures that the local copy is safe and offers NO manual fix", () => {
    const { sub, fix } = stuckCopy([present("Daily note.md")]);
    expect(sub).toContain("safe on this device");
    expect(sub).toContain("when the connection recovers");
    expect(fix).toBeNull(); // the advice is wait; a delete recipe here would be dangerous
  });

  it("untracked (no path): says it is harmless and offers no fix (the recipe needs a path)", () => {
    const { sub, fix } = stuckCopy([untracked]);
    expect(sub).toContain("does not affect your files");
    expect(fix).toBeNull();
  });

  it("multi, all absent: pluralized cause + the fix", () => {
    const { sub, fix } = stuckCopy([absent("a.md"), absent("b.md")]);
    expect(sub).toContain("other devices");
    expect(sub).toContain("nothing here to lose");
    expect(fix).toContain("the same path");
  });

  it("multi, all on disk: no fix at all", () => {
    const { sub, fix } = stuckCopy([present("a.md"), present("b.md")]);
    expect(sub).toContain("Your copies are safe");
    expect(fix).toBeNull();
  });

  it("multi, MIXED: the fix is scoped by tag so on-disk items are visibly excluded", () => {
    const { fix } = stuckCopy([absent("a.md"), present("b.md")]);
    expect(fix).toContain('"content never arrived"');
  });

  it("multi with only on-disk + untracked: no fix (nothing the recipe applies to)", () => {
    const { fix } = stuckCopy([present("a.md"), untracked]);
    expect(fix).toBeNull();
  });
});
