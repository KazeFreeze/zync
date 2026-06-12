/**
 * Structural unit test for buildEditorBinding.
 *
 * NOTE: Behavioral validation (live editing, undo isolation, Gboard IME on Android)
 * is the forever-manual on-device gate that passed in Phase 0a — those scenarios
 * cannot be exercised in a headless Node environment and are intentionally out of scope
 * for this test suite.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { DocId } from "@zync/core";
import { YjsCrdtProvider } from "../src/index.js";
import { buildEditorBinding } from "../src/binding.js";

const id = (s: string): DocId => s as DocId;

describe("buildEditorBinding", () => {
  it("constructs without throwing and returns extension + destroy", () => {
    const provider = new YjsCrdtProvider();
    const doc = provider.createDoc(id("d1"));
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);

    const binding = buildEditorBinding(doc, awareness);

    expect(binding).toBeDefined();
    expect(Array.isArray(binding.extension)).toBe(true);
    expect(typeof binding.destroy).toBe("function");

    binding.destroy();
    ydoc.destroy();
    doc.destroy();
  });

  it("destroy() is idempotent — calling it twice does not throw", () => {
    const provider = new YjsCrdtProvider();
    const doc = provider.createDoc(id("d2"));
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);

    const binding = buildEditorBinding(doc, awareness);

    expect(() => {
      binding.destroy();
      binding.destroy(); // second call must be a no-op, not throw
    }).not.toThrow();

    ydoc.destroy();
    doc.destroy();
  });

  it("throws when given a non-Yjs CrdtDoc", () => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);

    // Hand-roll a minimal object that satisfies the CrdtDoc shape at runtime
    // but is NOT a YjsCrdtDoc instance — the factory must reject it.
    const fakeDoc = {} as Parameters<typeof buildEditorBinding>[0];

    expect(() => {
      buildEditorBinding(fakeDoc, awareness);
    }).toThrow("buildEditorBinding requires a Yjs-backed CrdtDoc");

    ydoc.destroy();
  });
});
