/**
 * Scenario — canonical-LF prose semantics (Phase-1 M0 gate #1; y-codemirror.next #35 +
 * hash-identity safety) over the REAL relay.
 *
 * `y-codemirror.next` (#35) corrupts CodeMirror positions when a `\r\n` lives inside the Yjs
 * doc (CM counts `\r\n` as ONE char, Yjs as TWO), so LF is the canonical form inside the CRDT.
 * Because Zync convergence is `stamp = sha256(text)` identity, a CRLF disk file vs an LF CRDT
 * would never converge — so the engine canonicalizes prose to LF at the decode boundary and a
 * CRLF file converges to LF via the EXISTING materialize/ingest write (a one-time churn).
 *
 * This scenario proves that end-to-end across two devices over the real relay:
 *   A seeds `mini`; B boots empty and pulls it. A then writes a NEW prose note whose ON-DISK
 *   bytes carry CRLF (and a lone CR) — injected as raw bytes via `/fs/write` so the CR truly
 *   reaches disk (a committed fixture would be normalized by git/editors). Both devices must
 *   converge to ONE byte-identical tree whose note is PURE LF (no `\r` byte on EITHER device).
 *
 * The CRLF content is generated at runtime (raw `Uint8Array` → base64 `/fs/write`) rather than
 * committed as a fixture, exactly so the carriage returns are guaranteed to land on disk.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { device, heal, resetStack, seedAndStart, waitConverged } from "../src/harness.js";

const a = device("device-a");
const b = device("device-b");

const NOTE = "notes/crlf.md";
/** Canonical (LF) form the note must converge to on BOTH devices. */
const LF = "windows line one\nwindows line two\nold-mac tail";
/** As authored on a Windows editor + an embedded lone CR — what actually hits disk. */
const CRLF = "windows line one\r\nwindows line two\r\nold-mac tail";

/** A SECOND note used by the zero-attach adopt-server scenario (distinct path so the two
 * tests do not collide on the shared relay between resets). */
const ADOPT_NOTE = "notes/adopt-crlf.md";
const ADOPT_LF = "adopt line one\nadopt line two\nadopt tail";
const ADOPT_CRLF = "adopt line one\r\nadopt line two\r\nadopt tail";

beforeAll(async () => {
  await resetStack();
  await seedAndStart("device-a", ["device-b"], "mini");
}, 180_000);

afterAll(async () => {
  await heal("device-a").catch(() => undefined);
});

test("a CRLF prose write converges to byte-identical LF across devices (no CR survives)", async () => {
  // A writes a new note with REAL CRLF (+ lone CR) bytes on disk (raw bytes, not a string —
  // `device.write` base64-encodes the buffer verbatim, so the carriage returns reach disk).
  await a.write(NOTE, new TextEncoder().encode(CRLF));

  // Sanity: the bytes A just wrote genuinely carry a carriage return (a true repro).
  const seeded = await a.readBytes(NOTE);
  expect(seeded.includes(0x0d)).toBe(true); // 0x0d === '\r'

  // Converge over the real relay (tree shas must match on both — the convergence keystone).
  await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

  // Both devices' on-disk note is PURE LF — NO carriage-return byte survives on EITHER side.
  const bytesA = await a.readBytes(NOTE);
  const bytesB = await b.readBytes(NOTE);
  expect(bytesA.includes(0x0d)).toBe(false);
  expect(bytesB.includes(0x0d)).toBe(false);

  // And the content is exactly the canonical LF form, byte-identical across devices.
  const textA = new TextDecoder().decode(bytesA);
  const textB = new TextDecoder().decode(bytesB);
  expect(textA).toBe(LF);
  expect(textB).toBe(LF);

  // Quiescent — no perpetual divergence (the hash-identity hazard the canonicalization closes).
  expect((await a.status()).pendingDocs).toBe(0);
  expect((await b.status()).pendingDocs).toBe(0);
  // A one-time line-ending churn is NOT a conflict.
  expect((await a.status()).conflicts).toEqual([]);
  expect((await b.status()).conflicts).toEqual([]);
});

/**
 * Real-relay analogue of the in-process zero-attach adopt-server hole (review of 00f3819).
 *
 * A seeds a note as PURE LF and converges ALONE. A follower B then has the SAME note
 * PRE-POPULATED on disk as CRLF (Dropbox/git/Windows filled B's vault) BEFORE B's engine ever
 * starts — injected as raw bytes via `/fs/write` while B is idle, so the carriage returns truly
 * land on disk and B has NO base for the doc. When B starts, its bootstrap learns A's LF tree
 * stamp over the relay and finds its CRLF file's CANONICAL (LF) content byte-identical to that
 * stamp → the ZERO-ATTACH adopt-server branch. Pre-fix, B's disk stayed CRLF with no rewrite
 * (the doc is never attached, never materialized, never selected by catch-up), so `pendingDocs`
 * hashed the raw CRLF bytes against the LF stamp → stuck pending FOREVER. The fix rewrites B's
 * disk to LF once, echo-guarded, WITHOUT attaching the doc — so both devices converge.
 */
test("a follower adopting a PRE-EXISTING CRLF vault file rewrites it to LF (zero-attach adopt-server)", async () => {
  // Fresh stack so the relay holds none of the prior test's docs, and B boots with an EMPTY,
  // unstarted engine whose vault we can pre-populate.
  await resetStack();

  // A seeds the note as PURE LF and converges ALONE (B stays idle).
  await a.start();
  await a.write(ADOPT_NOTE, new TextEncoder().encode(ADOPT_LF));
  await waitConverged(["device-a"], { timeoutMs: 60_000 });
  expect((await a.readBytes(ADOPT_NOTE)).includes(0x0d)).toBe(false);

  // B's vault is PRE-POPULATED (Dropbox/git/Windows) with the SAME note as raw CRLF bytes
  // BEFORE B's engine starts — `/fs/write` hits disk directly regardless of sync state, and B
  // has no base for the doc. Sanity: the CR genuinely reached B's disk.
  await b.write(ADOPT_NOTE, new TextEncoder().encode(ADOPT_CRLF));
  expect((await b.readBytes(ADOPT_NOTE)).includes(0x0d)).toBe(true);

  // B starts: bootstrap learns A's LF stamp over the relay and takes the byte-identical
  // zero-attach adopt-server branch for its pre-existing CRLF file.
  await b.start();
  await waitConverged(["device-a", "device-b"], { timeoutMs: 90_000 });

  // B's pre-existing CRLF file was rewritten to PURE LF — no CR byte survives on either device.
  const bytesA = await a.readBytes(ADOPT_NOTE);
  const bytesB = await b.readBytes(ADOPT_NOTE);
  expect(bytesA.includes(0x0d)).toBe(false);
  expect(bytesB.includes(0x0d)).toBe(false);
  expect(new TextDecoder().decode(bytesA)).toBe(ADOPT_LF);
  expect(new TextDecoder().decode(bytesB)).toBe(ADOPT_LF);

  // Quiescent on both — the zero-attach adopt no longer strands B pending forever.
  expect((await a.status()).pendingDocs).toBe(0);
  expect((await b.status()).pendingDocs).toBe(0);
  expect((await a.status()).conflicts).toEqual([]);
  expect((await b.status()).conflicts).toEqual([]);
});
