/**
 * The portable persistence-candidate contract (PORTABLE — browser globals only:
 * `indexedDB`, `performance`, `navigator.storage`). Both candidates implement this
 * so the bench driver treats them identically. The shape mirrors Zync's two engine
 * ports — `DocStorePort` (opaque CRDT snapshot by docId) and `EngineStateStore`
 * (per-doc synced-stamp + dirty bool).
 */

export interface EngineState {
  /** `${sha256(text)}:${deviceId}` in the real engine; opaque here. */
  syncedStamp: string;
  dirty: boolean;
}

/**
 * A persistence candidate. The driver opens it fresh, seeds it, then in a SEPARATE
 * page/context re-opens it (cold) to measure durability + cold-open cost.
 */
export interface PersistenceCandidate {
  readonly name: string;

  /** Open/attach the store(s). For B this opens the single DB; for A this is a no-op shell. */
  open(): Promise<void>;

  /** Persist an opaque Yjs snapshot for `id` + its engine-state record. */
  save(id: string, snapshot: Uint8Array, state: EngineState): Promise<void>;

  /** Load the opaque snapshot for `id` (null if absent). */
  load(id: string): Promise<Uint8Array | null>;

  /** Load the engine-state record for `id` (null if absent). */
  loadState(id: string): Promise<EngineState | null>;

  /** Enumerate all known doc ids. */
  list(): Promise<string[]>;

  /** Remove a doc's snapshot + engine-state. */
  delete(id: string): Promise<void>;

  /** Close/detach everything (drop in-memory handles). */
  close(): Promise<void>;
}

/** Percentile (0–100) over a numeric sample using nearest-rank. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}

export function summarize(samples: number[]): {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
} {
  if (samples.length === 0) {
    return { count: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 };
  }
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((acc, v) => acc + v, 0);
  return {
    count: s.length,
    min: s[0] ?? 0,
    median: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1] ?? 0,
    mean: sum / s.length,
  };
}
