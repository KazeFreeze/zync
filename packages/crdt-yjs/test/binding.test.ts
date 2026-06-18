/**
 * Structural unit test for buildEditorBinding.
 *
 * NOTE: Behavioral validation (live editing, undo isolation, Gboard IME on Android)
 * is the forever-manual on-device gate that passed in Phase 0a — those scenarios
 * cannot be exercised in a headless Node environment and are intentionally out of scope
 * for this test suite.
 */
import { describe, it, expect } from "vitest";
import { Awareness } from "y-protocols/awareness";
import type { DocId } from "@zync/core";
import { YjsCrdtProvider, YjsCrdtDoc } from "../src/index.js";
import { buildEditorBinding } from "../src/binding.js";

const id = (s: string): DocId => s as DocId;

describe("buildEditorBinding", () => {
  it("constructs without throwing and returns extension + destroy (default local awareness)", () => {
    const provider = new YjsCrdtProvider();
    const doc = provider.createDoc(id("d1"));

    const binding = buildEditorBinding(doc); // awareness optional → local-only default

    expect(binding).toBeDefined();
    expect(Array.isArray(binding.extension)).toBe(true);
    expect(typeof binding.destroy).toBe("function");

    binding.destroy();
    doc.destroy();
  });

  it("accepts a caller-supplied awareness", () => {
    const provider = new YjsCrdtProvider();
    const doc = provider.createDoc(id("d1b")) as YjsCrdtDoc;
    const awareness = new Awareness(doc.yDoc);

    const binding = buildEditorBinding(doc, awareness);
    expect(binding).toBeDefined();

    binding.destroy();
    awareness.destroy();
    doc.destroy();
  });

  it("registers an editor origin on build and clears it on destroy", () => {
    const provider = new YjsCrdtProvider();
    const doc = provider.createDoc(id("d-origin")) as YjsCrdtDoc;
    expect(doc.editorOriginCount).toBe(0);

    const binding = buildEditorBinding(doc);
    expect(doc.editorOriginCount).toBe(1);

    binding.destroy();
    expect(doc.editorOriginCount).toBe(0);

    doc.destroy();
  });

  it("supports multiple concurrent bindings (multi-pane) on one doc", () => {
    const provider = new YjsCrdtProvider();
    const doc = provider.createDoc(id("d-multi")) as YjsCrdtDoc;

    const a = buildEditorBinding(doc);
    const b = buildEditorBinding(doc);
    expect(doc.editorOriginCount).toBe(2);

    a.destroy();
    expect(doc.editorOriginCount).toBe(1);
    b.destroy();
    expect(doc.editorOriginCount).toBe(0);

    doc.destroy();
  });

  it("destroy() is idempotent — calling it twice does not throw or double-unmark", () => {
    const provider = new YjsCrdtProvider();
    const doc = provider.createDoc(id("d2")) as YjsCrdtDoc;

    const binding = buildEditorBinding(doc);
    expect(() => {
      binding.destroy();
      binding.destroy(); // second call must be a no-op, not throw
    }).not.toThrow();
    expect(doc.editorOriginCount).toBe(0);

    doc.destroy();
  });

  it("throws when given a non-Yjs CrdtDoc", () => {
    // Hand-roll a minimal object that satisfies the CrdtDoc shape at runtime
    // but is NOT a YjsCrdtDoc instance — the factory must reject it.
    const fakeDoc = {} as Parameters<typeof buildEditorBinding>[0];

    expect(() => {
      buildEditorBinding(fakeDoc);
    }).toThrow("buildEditorBinding requires a Yjs-backed CrdtDoc");
  });
});
