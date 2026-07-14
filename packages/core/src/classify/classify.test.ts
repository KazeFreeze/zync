import { describe, it, expect } from "vitest";
import { classify } from "./classify.js";
import type { VaultPath } from "../ports.js";

const p = (s: string) => s as VaultPath;
const enc = (s: string) => new TextEncoder().encode(s);
const caps = { maxProseBytes: 1_000_000, configDir: ".obsidian", isMobile: false };

describe("classify", () => {
  it("routes prose markdown to crdt-prose", () => {
    expect(classify(p("notes/a.md"), enc("# hi"), caps).route).toBe("crdt-prose");
    expect(classify(p("b.txt"), enc("plain"), caps).route).toBe("crdt-prose");
  });
  it("routes structured text to structured-blob", () => {
    expect(classify(p("c.canvas"), enc("{}"), caps).route).toBe("structured-blob");
    expect(classify(p("d.json"), enc("{}"), caps).route).toBe("structured-blob");
  });
  it("routes binaries to binary-blob", () => {
    expect(classify(p("img.png"), new Uint8Array([0x89, 0x50]), caps).route).toBe("binary-blob");
  });
  it("routes .obsidian content to config", () => {
    expect(classify(p(".obsidian/appearance.json"), enc("{}"), caps).route).toBe("config");
  });
  it("demotes non-UTF-8 .md to binary-blob (no CRDT mangling)", () => {
    expect(classify(p("weird.md"), new Uint8Array([0xff, 0xfe, 0x00]), caps).route).toBe(
      "binary-blob",
    );
  });
  it("demotes oversize .md to binary-blob with a notice", () => {
    const r = classify(p("huge.md"), enc("x".repeat(2_000_000)), caps);
    expect(r.route).toBe("binary-blob");
    expect(r.notice).toMatch(/size/i);
  });
  it("excludes device-local + zync-internal paths", () => {
    expect(classify(p(".obsidian/workspace.json"), enc("{}"), caps).route).toBe("excluded");
    expect(classify(p(".obsidian/zync/base/x.json"), enc("{}"), caps).route).toBe("excluded");
    expect(classify(p(".trash/old.md"), enc("x"), caps).route).toBe("excluded");
  });

  it("excludes conflict backups under _conflicts/ (device-local, folder-based)", () => {
    expect(
      classify(
        p("_conflicts/notes/x (conflict, dev, ts).md"),
        enc("losing text"),
        caps,
      ).route,
    ).toBe("excluded");
  });

  it("does NOT exclude a beside-original (conflict, …) path — that is a synced orphan RECOVERY, not a device-local backup", () => {
    // Only the _conflicts/ FOLDER is device-local. A beside-original recovery path is a
    // LIVE, SYNCING doc; excluding it would make recovered concurrent-create losers non-syncing.
    expect(
      classify(
        p("notes/x (conflict, dev, ts).md"),
        enc("recovered orphan text"),
        caps,
      ).route,
    ).toBe("crdt-prose");
  });

  it("does NOT exclude a benign note that happens to mention 'conflict'", () => {
    expect(classify(p("notes/x.md"), enc("# hi"), caps).route).toBe("crdt-prose");
  });
  it("Caps.isMobile is accepted and does not alter route decisions", () => {
    // Compile-level guarantee: a Caps literal with isMobile:true must be accepted.
    const mobileCaps: Parameters<typeof classify>[2] = {
      maxProseBytes: 1_000_000,
      configDir: ".obsidian",
      isMobile: true,
    };
    expect(classify(p("notes/a.md"), enc("# hi"), mobileCaps).route).toBe("crdt-prose");
    expect(classify(p(".obsidian/plugins/dv/main.js"), enc(""), mobileCaps).route).toBe("config");
  });
});
