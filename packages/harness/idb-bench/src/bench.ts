/**
 * In-page benchmark driver (PORTABLE — runs in any browser context; exposed on
 * `window.zyncBench` by `entry.ts`). The Playwright runner calls these one phase
 * per page so "cold open" lands in a genuinely fresh page (in-memory caches dropped).
 *
 * Each candidate is keyed by name; the runner picks A or B. All timings use
 * `performance.now()` (ms).
 */
import * as Y from "yjs";
import { CandidateA } from "./candidateA";
import { CandidateB } from "./candidateB";
import type { EngineState, PersistenceCandidate } from "./candidate";
import { summarize } from "./candidate";
import { generateCorpus, corpusStats, type DocSpec, type WorkloadConfig } from "./workload";

/** Build the opaque Yjs snapshot for a doc body (what the engine would persist). */
function snapshotFor(body: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, body);
  const snap = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return snap;
}

/** Append `extra` to a doc's text and re-encode — a "small edit / dirty re-save". */
function editedSnapshot(body: string, extra: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, body + extra);
  const snap = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return snap;
}

function makeCandidate(which: "A" | "B"): PersistenceCandidate {
  return which === "A" ? new CandidateA() : new CandidateB();
}

async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  // `navigator.storage` is typed as always-present, but guard the method at runtime
  // for engines that lack the StorageManager API (returns -1 → flagged in the report).
  const storage = navigator.storage as StorageManager | undefined;
  if (storage && typeof storage.estimate === "function") {
    const e = await storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  }
  return { usage: -1, quota: -1 };
}

async function dbCount(): Promise<number> {
  if (typeof indexedDB.databases === "function") {
    return (await indexedDB.databases()).length;
  }
  return -1; // unsupported (e.g. Firefox) — flagged in the report
}

/**
 * Count the IDB databases that hold a DOC SNAPSHOT (the structural headline). For
 * Candidate A that is every DB whose name is NOT the `::state` engine-state sidecar;
 * for Candidate B every doc snapshot lives in the ONE `docs` store of a single DB,
 * so the doc-bearing-DB count is 1.
 */
async function docDbCount(): Promise<number> {
  if (typeof indexedDB.databases !== "function") return -1;
  const dbs = await indexedDB.databases();
  return dbs.filter((d) => d.name && !d.name.endsWith("::state")).length;
}

/** Wipe every IDB database (clean slate between candidates/reps). */
async function wipeAll(): Promise<number> {
  if (typeof indexedDB.databases !== "function") return -1;
  const dbs = await indexedDB.databases();
  let deleted = 0;
  for (const info of dbs) {
    const name = info.name;
    if (!name) continue;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => {
        deleted++;
        resolve();
      };
      req.onerror = () => {
        resolve();
      };
      req.onblocked = () => {
        resolve();
      };
    });
  }
  return deleted;
}

export interface PhaseResult {
  ms: number;
  [k: string]: number;
}

export interface SeedResult extends PhaseResult {
  docsSeeded: number;
  /** Total IDB databases after seeding (`indexedDB.databases().length`). */
  dbCountAfter: number;
  /** IDB databases holding a doc snapshot (A: per-doc DBs; B: the single DB → 1). */
  docDbCount: number;
  usageBytes: number;
  quotaBytes: number;
  whenSyncedMin?: number;
  whenSyncedMedian?: number;
  whenSyncedP95?: number;
  whenSyncedMax?: number;
}

let corpus: DocSpec[] | null = null;
function getCorpus(cfg?: WorkloadConfig): DocSpec[] {
  corpus ??= generateCorpus(cfg);
  return corpus;
}

/** Stash the seeded ids so cold-open/list/load phases in fresh pages can reuse them. */
function corpusIds(cfg?: WorkloadConfig): string[] {
  return getCorpus(cfg).map((d) => d.id);
}

/** Deterministic pseudo-random pick of `n` ids (seeded by index, not Math.random). */
function pickN(ids: string[], n: number, seed: number): string[] {
  const out: string[] = [];
  let x = seed >>> 0;
  const used = new Set<number>();
  while (out.length < n && used.size < ids.length) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const idx = x % ids.length;
    if (used.has(idx)) continue;
    used.add(idx);
    const id = ids[idx];
    if (id) out.push(id);
  }
  return out;
}

export interface BenchApi {
  config(): { count: number; stats: ReturnType<typeof corpusStats> };
  wipe(): Promise<number>;
  estimate(): Promise<{ usage: number; quota: number }>;
  dbCount(): Promise<number>;
  /** Phase: populate all docs from scratch. */
  seed(which: "A" | "B", cfg?: WorkloadConfig): Promise<SeedResult>;
  /** Phase: cold open in THIS (fresh) page — make all docs available. */
  coldOpen(which: "A" | "B", cfg?: WorkloadConfig): Promise<PhaseResult>;
  /** Phase: list all doc ids. */
  listIds(which: "A" | "B"): Promise<PhaseResult>;
  /** Phase: load 20 random docs. */
  loadRandom(which: "A" | "B", n: number, cfg?: WorkloadConfig): Promise<PhaseResult>;
  /** Phase: re-save `n` dirty docs (small edit). */
  saveDirty(which: "A" | "B", n: number, cfg?: WorkloadConfig): Promise<PhaseResult>;
  /** Phase: delete `n` docs + re-list (orphan-sweep shape). */
  deleteAndRelist(which: "A" | "B", n: number, cfg?: WorkloadConfig): Promise<PhaseResult>;
}

export const bench: BenchApi = {
  config() {
    const c = getCorpus();
    return { count: c.length, stats: corpusStats(c) };
  },

  wipe: wipeAll,
  estimate: storageEstimate,
  dbCount,

  async seed(which, cfg) {
    const docs = getCorpus(cfg);
    const cand = makeCandidate(which);
    await cand.open();
    const t0 = performance.now();
    for (const d of docs) {
      const snap = snapshotFor(d.body);
      const state: EngineState = { syncedStamp: `seed:${d.id}`, dirty: false };
      await cand.save(d.id, snap, state);
    }
    const ms = performance.now() - t0;
    const dbCountAfter = await dbCount();
    const docDbs = await docDbCount();
    const est = await storageEstimate();
    const result: SeedResult = {
      ms,
      docsSeeded: docs.length,
      dbCountAfter,
      docDbCount: docDbs,
      usageBytes: est.usage,
      quotaBytes: est.quota,
    };
    if (cand instanceof CandidateA) {
      const s = summarize(cand.whenSyncedSamples);
      result.whenSyncedMin = s.min;
      result.whenSyncedMedian = s.median;
      result.whenSyncedP95 = s.p95;
      result.whenSyncedMax = s.max;
    }
    await cand.close();
    return result;
  },

  async coldOpen(which, cfg) {
    const ids = corpusIds(cfg);
    const cand = makeCandidate(which);
    const t0 = performance.now();
    await cand.open();
    // "All docs available" — for A this means instantiating every per-doc
    // persistence + whenSynced; for B the single open already exposes them, so we
    // confirm availability by listing (the engine's first act on boot).
    if (cand instanceof CandidateA) {
      // capture whenSynced latency distribution on cold open
      for (const id of ids) {
        await cand.load(id); // ensure() opens the per-doc persistence + whenSynced
      }
      const ms = performance.now() - t0;
      const s = summarize(cand.whenSyncedSamples);
      const out: PhaseResult = {
        ms,
        whenSyncedMin: s.min,
        whenSyncedMedian: s.median,
        whenSyncedP95: s.p95,
        whenSyncedMax: s.max,
      };
      await cand.close();
      return out;
    }
    const keys = await cand.list();
    const ms = performance.now() - t0;
    await cand.close();
    return { ms, available: keys.length };
  },

  async listIds(which) {
    const cand = makeCandidate(which);
    await cand.open();
    const t0 = performance.now();
    const ids = await cand.list();
    const ms = performance.now() - t0;
    await cand.close();
    return { ms, listed: ids.length };
  },

  async loadRandom(which, n, cfg) {
    const ids = pickN(corpusIds(cfg), n, 0xa5a5);
    const cand = makeCandidate(which);
    await cand.open();
    const t0 = performance.now();
    let bytes = 0;
    for (const id of ids) {
      const snap = await cand.load(id);
      if (snap) bytes += snap.byteLength;
      await cand.loadState(id);
    }
    const ms = performance.now() - t0;
    await cand.close();
    return { ms, loaded: ids.length, bytes };
  },

  async saveDirty(which, n, cfg) {
    const docs = getCorpus(cfg);
    const ids = pickN(
      docs.map((d) => d.id),
      n,
      0x1234,
    );
    const byId = new Map(docs.map((d) => [d.id, d]));
    const cand = makeCandidate(which);
    await cand.open();
    const t0 = performance.now();
    for (const id of ids) {
      const d = byId.get(id);
      if (!d) continue;
      const snap = editedSnapshot(d.body, ` edit-${id}`);
      const state: EngineState = { syncedStamp: `dirty:${id}`, dirty: true };
      await cand.save(id, snap, state);
    }
    const ms = performance.now() - t0;
    await cand.close();
    return { ms, saved: ids.length };
  },

  async deleteAndRelist(which, n, cfg) {
    const ids = pickN(corpusIds(cfg), n, 0xbeef);
    const cand = makeCandidate(which);
    await cand.open();
    const t0 = performance.now();
    for (const id of ids) await cand.delete(id);
    const remaining = await cand.list();
    const ms = performance.now() - t0;
    await cand.close();
    return { ms, deleted: ids.length, remaining: remaining.length };
  },
};

export type { EngineState };
