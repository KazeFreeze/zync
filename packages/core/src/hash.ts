import type { Sha256 } from "./ports.js";

/**
 * CANONICAL-LF PROSE NORMALIZATION (Phase-1 M0 gate #1 — y-codemirror.next #35 +
 * hash-identity safety).
 *
 * WHY: the Phase-1 editor binding (`y-codemirror.next`) has OPEN bug #35 — a `\r\n`
 * inside a Yjs doc corrupts CodeMirror positions (CM counts `\r\n` as ONE char, Yjs
 * as TWO). The documented mitigation is LF-ONLY inside Yjs. Zync's convergence is
 * built on `stamp = sha256(text)` identity, so if the CRDT side were LF while disk
 * stayed CRLF, `sha256(doc.getText()) !== sha256(diskBytes)` for the SAME note ⇒
 * perpetual non-convergence (dirty never clears, echo suppression misses, clean-settle
 * can't fire, materialize endlessly rewrites disk). The fix is to make LF the CANONICAL
 * form EVERYWHERE the engine turns vault bytes into PROSE text — so the CRDT/base/stamps
 * stay internally consistent (LF, not mixed) AND the future binding is safe. A CRLF vault
 * file then converges to LF via the EXISTING materialize/ingest write (a one-time churn).
 *
 * Applied ONLY to prose (`crdt-prose`) at the DECODE boundary — never to blobs (blobs are
 * bytes, content-addressed as-is). PURE string transform: `\r\n` → `\n` AND lone `\r` → `\n`
 * (true canonical LF). A no-op for text that is already LF.
 */
export function canonicalizeProse(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

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
