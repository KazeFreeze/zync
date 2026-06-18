/**
 * Deterministic synthetic workload generator (PORTABLE — no browser/Obsidian deps).
 *
 * Mirrors the real Zync vault shape: ~1,260 notes / ~2.96 MB text → ~2.3 KB avg,
 * varied 0.5–15 KB with a few larger outliers. Content is synthetic lorem-ish text
 * (NO personal data) produced from a seeded PRNG so every run/candidate sees the
 * IDENTICAL corpus. The same generator is intended to be embeddable later in an
 * Obsidian-mobile command for the real-device run.
 */

/** A tiny seeded PRNG (mulberry32) — deterministic across V8 engines. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "note",
  "vault",
  "sync",
  "engine",
  "doc",
  "crdt",
  "merge",
  "stamp",
  "dirty",
  "snapshot",
  "index",
  "blob",
  "relay",
  "device",
  "offline",
  "converge",
  "delta",
  "update",
  "transport",
  "persist",
  "lorem",
  "ipsum",
  "dolor",
  "amet",
  "tempor",
  "labore",
  "magna",
  "aliqua",
  "minim",
  "nostrud",
];

/** Build a deterministic text body of approximately `targetBytes` UTF-8 bytes. */
export function makeBody(rnd: () => number, targetBytes: number): string {
  const parts: string[] = [];
  let bytes = 0;
  while (bytes < targetBytes) {
    const wordsInLine = 6 + Math.floor(rnd() * 12);
    const line: string[] = [];
    for (let i = 0; i < wordsInLine; i++) {
      const w = WORDS[Math.floor(rnd() * WORDS.length)] ?? "note";
      line.push(w);
    }
    const sentence = line.join(" ") + ".\n";
    parts.push(sentence);
    // ASCII-only synthetic content, so 1 char ≈ 1 byte.
    bytes += sentence.length;
  }
  return parts.join("");
}

export interface DocSpec {
  /** Stable id e.g. `note-0001` (mirrors DocId). */
  id: string;
  /** Target text size in bytes. */
  sizeBytes: number;
  /** The synthetic text body. */
  body: string;
}

export interface WorkloadConfig {
  count: number;
  seed: number;
}

export const DEFAULT_WORKLOAD: WorkloadConfig = { count: 1260, seed: 0x5eed };

/**
 * Produce a deterministic corpus. Size distribution is tuned to land near the real
 * vault's ~2.3 KB mean (~2.96 MB over ~1,260 notes) with a realistic fat tail:
 *   - ~88% in 0.5–4 KB (the bulk of notes; most cluster low)
 *   - ~10% in 4–15 KB (longer notes)
 *   - ~2% large outliers 15–45 KB (a few big docs)
 */
export function generateCorpus(cfg: WorkloadConfig = DEFAULT_WORKLOAD): DocSpec[] {
  const rnd = mulberry32(cfg.seed);
  const docs: DocSpec[] = [];
  for (let i = 0; i < cfg.count; i++) {
    const r = rnd();
    let sizeBytes: number;
    if (r < 0.88) {
      // 0.5–4 KB, square-weighted toward the low end so the mean sits near ~2 KB.
      const t = rnd() * rnd();
      sizeBytes = 500 + Math.floor(t * 3500);
    } else if (r < 0.98) {
      sizeBytes = 4000 + Math.floor(rnd() * 11000); // 4–15 KB
    } else {
      sizeBytes = 15000 + Math.floor(rnd() * 30000); // 15–45 KB outliers
    }
    const id = `note-${String(i).padStart(4, "0")}`;
    docs.push({ id, sizeBytes, body: makeBody(rnd, sizeBytes) });
  }
  return docs;
}

/** Summary stats over a corpus, for the report header. */
export function corpusStats(docs: DocSpec[]): {
  count: number;
  totalBytes: number;
  avgBytes: number;
  minBytes: number;
  maxBytes: number;
} {
  let total = 0;
  let min = Infinity;
  let max = 0;
  for (const d of docs) {
    const b = d.body.length;
    total += b;
    if (b < min) min = b;
    if (b > max) max = b;
  }
  return {
    count: docs.length,
    totalBytes: total,
    avgBytes: Math.round(total / docs.length),
    minBytes: min === Infinity ? 0 : min,
    maxBytes: max,
  };
}
