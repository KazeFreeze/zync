/**
 * Deterministic fixture-prep for the routing matrix.
 *
 * Generates the ~5 MB binary blob fixture (`assets/large.bin`) at prep time
 * rather than committing 5 MB to git. The bytes are DETERMINISTIC (a fixed seed
 * fed through a tiny xorshift PRNG) so every prep run — and therefore every
 * device that loads this fixture — produces the BYTE-IDENTICAL file (same
 * sha256). The blob scenario relies on that determinism to assert a matching sha
 * across devices.
 *
 * Lives OUTSIDE the loadable `routing/` fixture dir on purpose: `/vault/load`
 * recursively copies the whole fixture subtree into a vault, so a generator
 * script left inside `routing/` would itself land in the vault as spurious
 * content. The output it writes (`routing/assets/large.bin`) is gitignored
 * (see fixtures/.gitignore). Run from anywhere:
 *   node packages/harness/fixtures/routing-prepare.mjs
 * The harness scenarios invoke this automatically in a beforeAll hook.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** ~5 MB, a round number above any prose cap; routes to binary-blob. */
export const LARGE_BIN_BYTES = 5 * 1024 * 1024;
/** Vault-relative path of the generated blob INSIDE the loaded routing fixture. */
export const LARGE_BIN_REL = "assets/large.bin";

/** A 32-bit xorshift PRNG — deterministic, dependency-free, good enough for fixture bytes. */
function fillDeterministic(buf, seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < buf.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
}

export function prepareRoutingFixtures() {
  const outPath = join(HERE, "routing", LARGE_BIN_REL);
  if (!existsSync(outPath)) {
    mkdirSync(dirname(outPath), { recursive: true });
    const buf = Buffer.allocUnsafe(LARGE_BIN_BYTES);
    fillDeterministic(buf, 0x5eed1234);
    writeFileSync(outPath, buf);
  }
  return outPath;
}

// Run directly: node prepare.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const p = prepareRoutingFixtures();
  console.log(`[routing-fixtures] ready: ${p} (${String(LARGE_BIN_BYTES)} bytes)`);
}
