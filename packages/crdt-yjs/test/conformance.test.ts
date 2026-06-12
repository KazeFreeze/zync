import { describe, it, expect } from "vitest";
import type { CrdtProvider, CrdtDoc, DocId, EditOrigin, TextEdit } from "@zync/core";
import { YjsCrdtProvider } from "../src/index.js";

const id = (s: string): DocId => s as DocId;

/**
 * Provider-parameterized CRDT conformance suite.
 *
 * Written against the `@zync/core` ports only — no Yjs imports here — so the
 * SAME suite can later be re-run against a Loro adapter via
 * `runCrdtConformance("loro", () => new LoroCrdtProvider())`.
 */
export function runCrdtConformance(label: string, make: () => CrdtProvider): void {
  describe(`CrdtProvider conformance [${label}]`, () => {
    const ins = (at: number, insert: string): TextEdit => ({ at, delete: 0, insert });

    it("converges: snapshot ships A→B, then delta ships B→A", () => {
      const provider = make();
      const a = provider.createDoc(id("doc"));
      a.applyEdits([ins(0, "hello")], "local-editor");
      expect(a.getText()).toBe("hello");

      // Ship A's full snapshot to a fresh B.
      const b = provider.loadDoc(id("doc"), a.encodeSnapshot());
      expect(b.getText()).toBe("hello");

      // B edits; ship a delta back to A; both converge.
      const svA = a.encodeStateVector();
      b.applyEdits([ins(5, " world")], "local-editor");
      a.applyUpdate(b.encodeUpdateSince(svA), "remote");
      expect(a.getText()).toBe("hello world");
      expect(b.getText()).toBe("hello world");

      a.destroy();
      b.destroy();
    });

    it("is idempotent: re-applying the same update does not double content", () => {
      const provider = make();
      const a = provider.createDoc(id("doc"));
      a.applyEdits([ins(0, "hello")], "local-editor");
      const snap = a.encodeSnapshot();

      const b = provider.createDoc(id("doc"));
      b.applyUpdate(snap, "remote");
      b.applyUpdate(snap, "remote"); // second apply is a no-op
      expect(b.getText()).toBe("hello");

      a.destroy();
      b.destroy();
    });

    it("encodeUpdateSince produces a minimal delta smaller than a full snapshot", () => {
      const provider = make();
      const a = provider.createDoc(id("doc"));
      // Make A reasonably large so a full snapshot dwarfs a one-char delta.
      a.applyEdits(
        [ins(0, "the quick brown fox jumps over the lazy dog. ".repeat(20))],
        "local-editor",
      );

      // B catches up fully.
      const b = provider.loadDoc(id("doc"), a.encodeSnapshot());

      // A makes a tiny edit; B should converge from the minimal delta.
      const svB = b.encodeStateVector();
      a.applyEdits([ins(a.getText().length, "!")], "local-editor");
      const delta = a.encodeUpdateSince(svB);
      const snapshot = a.encodeSnapshot();

      b.applyUpdate(delta, "remote");
      expect(b.getText()).toBe(a.getText());
      expect(delta.length).toBeLessThan(snapshot.length);

      a.destroy();
      b.destroy();
    });

    it("labels origin: local-bridge edits and remote updates surface their origin to onUpdate", () => {
      const provider = make();
      const a = provider.createDoc(id("doc"));
      const seen: EditOrigin[] = [];
      const unsub = a.onUpdate((_u, origin) => seen.push(origin));

      a.applyEdits([ins(0, "x")], "local-bridge");

      const b = provider.createDoc(id("doc"));
      b.applyEdits([ins(0, "y")], "local-editor");
      a.applyUpdate(b.encodeSnapshot(), "remote");

      expect(seen).toContain("local-bridge");
      expect(seen).toContain("remote");

      unsub();
      a.destroy();
      b.destroy();
    });

    it("map per-key LWW: distinct keys union, same key converges to one value", () => {
      interface Node {
        docId: string;
        type: string;
        stamp: string;
      }
      const provider = make();
      const a = provider.createDoc(id("doc"));
      const b = provider.createDoc(id("doc"));

      // Each writes a DISTINCT key.
      a.getMap<Node>("tree").set("a.md", { docId: "a", type: "note", stamp: "sa" });
      b.getMap<Node>("tree").set("b.md", { docId: "b", type: "note", stamp: "sb" });

      // Exchange full updates → union of keys.
      const sync = (from: CrdtDoc, to: CrdtDoc): void => {
        to.applyUpdate(from.encodeSnapshot(), "remote");
      };
      sync(a, b);
      sync(b, a);

      const keysA = a
        .getMap<Node>("tree")
        .entries()
        .map(([k]) => k)
        .sort();
      const keysB = b
        .getMap<Node>("tree")
        .entries()
        .map(([k]) => k)
        .sort();
      expect(keysA).toEqual(["a.md", "b.md"]);
      expect(keysB).toEqual(["a.md", "b.md"]);

      // Both set the SAME key concurrently → LWW convergence to ONE identical value.
      a.getMap<Node>("tree").set("shared.md", { docId: "a", type: "note", stamp: "from-a" });
      b.getMap<Node>("tree").set("shared.md", { docId: "b", type: "note", stamp: "from-b" });
      sync(a, b);
      sync(b, a);

      const sharedA = a.getMap<Node>("tree").get("shared.md");
      const sharedB = b.getMap<Node>("tree").get("shared.md");
      expect(sharedA).toEqual(sharedB);
      expect(sharedA).toBeDefined();

      a.destroy();
      b.destroy();
    });
  });
}

runCrdtConformance("yjs", () => new YjsCrdtProvider());
