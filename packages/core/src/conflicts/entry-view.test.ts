import { describe, it, expect } from "vitest";
import type { InboxEntry } from "./inbox.js";
import { describeInboxEntry, isActionableConflict, type EntryAction } from "./entry-view.js";

const actions = (e: InboxEntry, artifactLocal: boolean): EntryAction[] =>
  describeInboxEntry(e, { artifactLocal }).actions.map((a) => a.action);

const base = (over: Partial<InboxEntry>): InboxEntry => ({
  id: "x",
  kind: "conflict",
  path: "notes/a.md" as InboxEntry["path"],
  ...over,
});

describe("describeInboxEntry", () => {
  it("content conflict with local artifact → full assisted-resolve", () => {
    const e = base({ artifactPath: "notes/a (conflict, dev-b, abc1).md" as InboxEntry["path"] });
    expect(actions(e, true)).toEqual([
      "open-current",
      "open-backup",
      "keep-current",
      "keep-backup",
      "acknowledge",
    ]);
  });

  it("content conflict WITHOUT local artifact → acknowledge-only", () => {
    const e = base({ artifactPath: "notes/a (conflict, dev-b, abc1).md" as InboxEntry["path"] });
    expect(actions(e, false)).toEqual(["open-current", "acknowledge"]);
  });

  it("supervised-import relabels keep-current/keep-backup for the import framing", () => {
    const e = base({
      kind: "supervised-import",
      artifactPath: "notes/a (conflict, x, y).md" as InboxEntry["path"],
    });
    const view = describeInboxEntry(e, { artifactLocal: true });
    const keepCurrent = view.actions.find((a) => a.action === "keep-current");
    const keepBackup = view.actions.find((a) => a.action === "keep-backup");
    expect(keepCurrent?.label).toBe("Keep imported server copy");
    expect(keepBackup?.label).toBe("Restore my local copy");
  });

  it("pending-delete → confirm/keep", () => {
    const e = base({ kind: "pending-delete", docId: "d1" as NonNullable<InboxEntry["docId"]> });
    expect(actions(e, false)).toEqual(["open-current", "confirm-delete", "keep"]);
  });

  it("resurrected → open + acknowledge", () => {
    const e = base({ kind: "resurrected", docId: "d1" as NonNullable<InboxEntry["docId"]> });
    expect(actions(e, false)).toEqual(["open-current", "acknowledge"]);
  });

  it("rename-refused notice (conflict, no artifactPath) → acknowledge-only", () => {
    const e = base({ id: "conflict:rename-refused:notes/b.md" });
    expect(actions(e, false)).toEqual(["acknowledge"]);
  });

  it("recovered-file notice (conflict, no artifactPath, real path) → open + acknowledge", () => {
    const e = base({
      id: "conflict:notes/a.md:d1",
      docId: "d1" as NonNullable<InboxEntry["docId"]>,
    });
    expect(actions(e, false)).toEqual(["open-current", "acknowledge"]);
  });

  it("blob:sync-failed is a transient status row → no actions", () => {
    const e = base({ id: "blob:sync-failed", detail: "3 files could not sync" });
    expect(actions(e, false)).toEqual([]);
  });
});

describe("isActionableConflict", () => {
  it("counts content conflicts and pending-deletes, not informational notices", () => {
    const content = base({ artifactPath: "notes/a (conflict, x, y).md" as InboxEntry["path"] });
    const pending = base({
      kind: "pending-delete",
      docId: "d1" as NonNullable<InboxEntry["docId"]>,
    });
    const resurrected = base({
      kind: "resurrected",
      docId: "d1" as NonNullable<InboxEntry["docId"]>,
    });
    const renameRefused = base({ id: "conflict:rename-refused:notes/b.md" });
    const blob = base({ id: "blob:sync-failed" });
    expect(isActionableConflict(content)).toBe(true);
    expect(isActionableConflict(pending)).toBe(true);
    expect(isActionableConflict(resurrected)).toBe(false);
    expect(isActionableConflict(renameRefused)).toBe(false);
    expect(isActionableConflict(blob)).toBe(false);
  });
});
