import type { Sha256 } from "./ports.js";

/**
 * Content hashing via Web Crypto. `crypto.subtle` is a GLOBAL in Obsidian's
 * WebView and in Node >= 20 — we intentionally do NOT `import` `node:crypto`,
 * which would trip the core firewall (no `node:` imports allowed in `@zync/core`).
 */
export async function sha256OfBytes(bytes: Uint8Array): Promise<Sha256> {
  // Normalize to a plain `ArrayBuffer`-backed view: `TextEncoder`/upstream
  // `Uint8Array`s can be `Uint8Array<ArrayBufferLike>` (possibly SharedArrayBuffer),
  // which the strict `BufferSource` signature of `crypto.subtle.digest` rejects.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") as Sha256;
}

/** Canonical text hashing: hash the UTF-8 bytes of `text`. */
export async function sha256OfText(text: string): Promise<Sha256> {
  return sha256OfBytes(new TextEncoder().encode(text));
}
