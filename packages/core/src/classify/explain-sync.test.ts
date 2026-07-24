// packages/core/src/classify/explain-sync.test.ts
import { describe, it, expect } from "vitest";
import {
  explainSync,
  resolveLiveState,
  isProseExtension,
  type ExplainFacts,
} from "./explain-sync.js";
import type { VaultPath } from "../ports.js";

const base: ExplainFacts = {
  zyncStorePrefix: ".obsidian/zync",
  obsidianConfigPrefix: ".obsidian/",
  plane: "prose",
  live: "synced",
  demotedProse: false,
  conn: "connected",
};
const p = (s: string) => s as VaultPath;
const ex = (path: string, f: Partial<ExplainFacts> = {}) => explainSync(p(path), { ...base, ...f });

describe("explainSync — excluded arms (decision order)", () => {
  it("trash wins first", () => {
    const r = ex(".trash/old.md");
    expect(r.status).toBe("excluded");
    expect(r.reason).toBe("trash");
    expect(r.title).toBe("Excluded");
    expect(r.detail).toMatch(/trash/i);
    expect(r.action).toBeUndefined();
  });
  it("zync state store", () => {
    const r = ex(".obsidian/zync/base/x.json");
    expect(r.reason).toBe("zync-internal");
  });
  it("conflict artifact beats the coarse config-plane arm", () => {
    const r = ex("_conflicts/Note.md");
    expect(r.reason).toBe("conflict-artifact");
    expect(r.detail).toMatch(/conflict backup/i);
  });
  it("zync's own plugin bundle is self-excluded", () => {
    const r = ex(".obsidian/plugins/zync/main.js");
    expect(r.reason).toBe("self-excluded");
    expect(r.detail).toMatch(/BRAT/);
  });
  it("a non-zync plugin file is the coarse config-plane arm, not self-excluded", () => {
    const r = ex(".obsidian/plugins/calendar/main.js");
    expect(r.reason).toBe("config-plane");
  });
  it("any other .obsidian file is the coarse config-plane arm", () => {
    const r = ex(".obsidian/app.json");
    expect(r.reason).toBe("config-plane");
  });
  it("zync-internal is checked before the generic config-plane arm", () => {
    expect(ex(".obsidian/zync/state.json").reason).toBe("zync-internal");
  });
});

describe("explainSync — live status arms", () => {
  it("prose synced → syncing, hedged copy", () => {
    const r = ex("Notes/A.md", { plane: "prose", live: "synced" });
    expect(r.status).toBe("syncing");
    expect(r.title).toBe("Synced");
    expect(r.reason).toBeUndefined();
    expect(r.action).toBeUndefined();
    expect(r.detail).toMatch(/acknowledged by the relay/i);
    expect(r.detail).toMatch(/hasn't caught up/i);
  });
  it("prose pending → pending", () => {
    const r = ex("Notes/A.md", { live: "pending" });
    expect(r.status).toBe("pending");
    expect(r.title).toBe("Pending");
  });
  it("absent → not-tracked, with a re-verify action", () => {
    const r = ex("Notes/New.md", { live: "absent" });
    expect(r.status).toBe("not-tracked");
    expect(r.title).toBe("Not tracked");
    expect(r.detail).toMatch(/sync shortly/i);
    expect(r.action).toBe("reverify");
  });
  it("demoted prose gets the blob-not-live-merged qualifier", () => {
    const r = ex("Big.md", { plane: "blob", live: "synced", demotedProse: true });
    expect(r.status).toBe("syncing");
    expect(r.detail).toMatch(/not live-merged/i);
  });
  it("a plain attachment gets the attachment qualifier", () => {
    const r = ex("img/pic.png", { plane: "blob", live: "synced", demotedProse: false });
    expect(r.detail).toMatch(/attachment|file/i);
  });
  it("offline appends a connection suffix on non-synced states", () => {
    const r = ex("Notes/A.md", { live: "pending", conn: "offline" });
    expect(r.detail).toMatch(/offline/i);
  });
  it("unauthorized appends an auth-error suffix on non-synced states", () => {
    const r = ex("Notes/A.md", { live: "absent", conn: "unauthorized" });
    expect(r.detail).toMatch(/authenticate/i);
  });
});

describe("resolveLiveState", () => {
  const inp = (o: Partial<Parameters<typeof resolveLiveState>[0]> = {}) =>
    resolveLiveState({
      hasLiveIndexEntry: false,
      indexPending: false,
      hasBlobEntry: false,
      blobOnDisk: false,
      isProseExt: false,
      ...o,
    });
  it("live index entry → prose plane; indexPending maps to live", () => {
    expect(inp({ hasLiveIndexEntry: true })).toEqual({
      plane: "prose",
      live: "synced",
      demotedProse: false,
    });
    expect(inp({ hasLiveIndexEntry: true, indexPending: true }).live).toBe("pending");
  });
  it("no index entry, no blob entry → blob/absent", () => {
    expect(inp()).toEqual({ plane: "blob", live: "absent", demotedProse: false });
  });
  it("blob entry on disk → synced; not on disk → pending (downloading)", () => {
    expect(inp({ hasBlobEntry: true, blobOnDisk: true }).live).toBe("synced");
    expect(inp({ hasBlobEntry: true, blobOnDisk: false }).live).toBe("pending");
  });
  it("a prose-ext file on the blob plane is flagged demotedProse", () => {
    expect(inp({ hasBlobEntry: true, blobOnDisk: true, isProseExt: true }).demotedProse).toBe(true);
  });
  it("a live index entry wins even when a blob entry is also present (prose beats blob)", () => {
    expect(inp({ hasLiveIndexEntry: true, hasBlobEntry: true, blobOnDisk: false })).toEqual({
      plane: "prose",
      live: "synced",
      demotedProse: false,
    });
  });
});

describe("isProseExtension", () => {
  it("true for md/markdown/txt (case-insensitive), false otherwise", () => {
    expect(isProseExtension("Notes/A.md")).toBe(true);
    expect(isProseExtension("a.MARKDOWN")).toBe(true);
    expect(isProseExtension("img/pic.png")).toBe(false);
    expect(isProseExtension("noext")).toBe(false);
  });
});
