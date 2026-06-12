import { describe, it, expect } from "vitest";
import { sha256OfBytes, sha256OfText } from "./hash.js";

/**
 * Content hashing via Web Crypto (`crypto.subtle`, a global in Obsidian's WebView
 * and Node >= 20 — NEVER `import node:crypto`, which would trip the core firewall).
 * Verified against the canonical NIST SHA-256 vectors for "" and "abc".
 */
describe("sha256OfText / sha256OfBytes (Web Crypto, zero-dep)", () => {
  it("crypto.subtle is available in this env (report, don't polyfill)", () => {
    expect(typeof crypto).toBe("object");
    expect(typeof crypto.subtle.digest).toBe("function");
  });

  it('sha256OfText("") === the known empty-string vector', async () => {
    expect(await sha256OfText("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('sha256OfText("abc") === the known "abc" vector', async () => {
    expect(await sha256OfText("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("sha256OfBytes and sha256OfText agree for the SAME text (UTF-8 canonical)", async () => {
    const text = "the quick brown fox — émojis 🦊 too";
    const bytesHash = await sha256OfBytes(new TextEncoder().encode(text));
    expect(await sha256OfText(text)).toBe(bytesHash);
  });
});
