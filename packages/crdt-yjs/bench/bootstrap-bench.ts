/**
 * bootstrap-bench.ts — localize the first-sync bootstrap cost (the ~0.8 notes/sec / ~16 min
 * for a 1247-note vault reported on-device). IN-MEMORY (InProcessBus + fakes): isolates the
 * ALGORITHMIC scaling (reconcile / index / dirty-set work) without real relay-latency or IDB
 * noise. If a scenario's time grows ~quadratically with N (doubling N ~quadruples time → ratio
 * ≈ 4), the bottleneck is algorithmic and fixable in-engine; if it stays ~linear (ratio ≈ 2) and
 * fast, the real-device cost is relay-latency / IDB and needs a real-relay benchmark next.
 *
 * Run: npx tsx packages/crdt-yjs/bench/bootstrap-bench.ts
 *
 * Scenarios per N:
 *  - SEED  : a single device with N local notes does its FIRST-EVER bootstrap (seeds all → every
 *            doc dirty → catch-up reconciles each). This is what happens when a pre-populated vault
 *            first starts — the suspected O(n^2) (reconcileDirtyDoc calls listDirty() per note).
 *  - ADOPT : device B, holding files BYTE-IDENTICAL to an already-synced device A, starts and adopts
 *            A's docIds (the A==B-identical "divergent import" path the user actually hit).
 */
import { SyncEngine, type EnginePorts, type EngineConfig } from "@zync/core";
import type { DeviceId, IdentityPort, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const path = (s: string): VaultPath => s as VaultPath;
const now = (): number => performance.now();

function identity(id: string): IdentityPort {
  return { deviceId: () => id as DeviceId, deviceName: () => id };
}

/** Count every method call on a port under `name.method` — to expose O(n^2) call-count growth
 *  (the real-device cost is dominated by the NUMBER of vault.read / getSyncedStamp calls, not the
 *  cheap in-memory ms). Pass a shared Map; read it after the run. */
function countWrap<T extends object>(name: string, obj: T, counts: Map<string, number>): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const key = `${name}.${String(prop)}`;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return fn.apply(target, args);
      };
    },
  });
}

function makeDevice(
  bus: InProcessBus,
  deviceId: string,
  counts?: Map<string, number>,
): { engine: SyncEngine; vault: FakeVault } {
  const vault = new FakeVault();
  const engineState = new MemEngineState();
  const ports: EnginePorts = {
    vault: counts ? countWrap("vault", vault, counts) : vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(deviceId),
    engineState: counts ? countWrap("engineState", engineState, counts) : engineState,
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return { engine: new SyncEngine(ports, config), vault };
}

/** A ~400-byte prose note, varied per index so hashes differ. */
function noteBody(i: number): string {
  const lines = [
    `# Note ${String(i)}`,
    "",
    `This is the body of note number ${String(i)}. It carries a few lines of prose so the`,
    "content hash is non-trivial and the CRDT seed does real work, like a typical vault note.",
    "",
    `- tag: bench/${String(i % 17)}`,
    `- created: 2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    "",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Phasellus ".repeat(2).trim(),
  ];
  return lines.join("\n");
}

async function seedNotes(vault: FakeVault, n: number): Promise<void> {
  for (let i = 0; i < n; i++)
    await vault.writeAtomic(path(`notes/n${String(i)}.md`), utf8(noteBody(i)));
}

interface Row {
  n: number;
  scenario: string;
  startMs: number;
  convergeMs: number;
  totalMs: number;
  notesPerSec: number;
  vaultReads: number;
  vaultReadsPerNote: number;
  getSyncedStamps: number;
}

async function benchSeed(n: number): Promise<Row> {
  const bus = new InProcessBus();
  const counts = new Map<string, number>();
  const a = makeDevice(bus, "dev-a", counts);
  await seedNotes(a.vault, n);
  const t0 = now();
  await a.engine.start();
  const startMs = now() - t0;
  const t1 = now();
  await a.engine.waitConverged();
  const convergeMs = now() - t1;
  await a.engine.stop();
  const totalMs = startMs + convergeMs;
  const vaultReads = counts.get("vault.read") ?? 0;
  return {
    n,
    scenario: "SEED",
    startMs,
    convergeMs,
    totalMs,
    notesPerSec: (n / totalMs) * 1000,
    vaultReads,
    vaultReadsPerNote: vaultReads / n,
    getSyncedStamps: counts.get("engineState.getSyncedStamp") ?? 0,
  };
}

async function benchAdopt(n: number): Promise<Row> {
  const bus = new InProcessBus();
  const a = makeDevice(bus, "dev-a");
  await seedNotes(a.vault, n);
  await a.engine.start();
  await a.engine.waitConverged();
  // B holds byte-identical files and adopts A's docIds (count B's port calls only).
  const counts = new Map<string, number>();
  const b = makeDevice(bus, "dev-b", counts);
  await seedNotes(b.vault, n);
  const t0 = now();
  await b.engine.start();
  const startMs = now() - t0;
  const t1 = now();
  await waitConvergeBoth(a.engine, b.engine);
  const convergeMs = now() - t1;
  await a.engine.stop();
  await b.engine.stop();
  const totalMs = startMs + convergeMs;
  const vaultReads = counts.get("vault.read") ?? 0;
  return {
    n,
    scenario: "ADOPT",
    startMs,
    convergeMs,
    totalMs,
    notesPerSec: (n / totalMs) * 1000,
    vaultReads,
    vaultReadsPerNote: vaultReads / n,
    getSyncedStamps: counts.get("engineState.getSyncedStamp") ?? 0,
  };
}

async function waitConvergeBoth(a: SyncEngine, b: SyncEngine): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await a.waitConverged();
    await b.waitConverged();
    if ((await a.pendingDocs()).length === 0 && (await b.pendingDocs()).length === 0) return;
  }
  throw new Error("waitConvergeBoth: did not settle");
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  const sizes = [100, 200, 400, 800, 1600, 3200];
  const rows: Row[] = [];
  for (const scenario of ["SEED", "ADOPT"] as const) {
    for (const n of sizes) {
      const row = scenario === "SEED" ? await benchSeed(n) : await benchAdopt(n);
      rows.push(row);
      console.log(
        `${scenario.padEnd(6)} N=${String(n).padStart(4)}  total=${fmt(row.totalMs).padStart(8)}  ${row.notesPerSec.toFixed(0).padStart(5)} notes/s  vault.read=${String(row.vaultReads).padStart(9)} (${row.vaultReadsPerNote.toFixed(1).padStart(7)}/note)  getSyncedStamp=${String(row.getSyncedStamps).padStart(9)}`,
      );
    }
  }
  // Two scaling signals as N doubles: total-time ratio (~2 linear, ~4 quadratic) AND vault.read/note
  // (FLAT = O(n) reads; GROWING with N = O(n^2) — the real-device bottleneck the profiler exposed).
  console.log(
    "\n--- scaling as N doubles (time ratio ~2 linear / ~4 quadratic; reads/note FLAT=O(n) / GROWING=O(n^2)) ---",
  );
  for (const scenario of ["SEED", "ADOPT"] as const) {
    const s = rows.filter((r) => r.scenario === scenario);
    const timeRatios: string[] = [];
    const readPerNote: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const cur = s[i];
      if (cur === undefined) continue;
      readPerNote.push(cur.vaultReadsPerNote.toFixed(1));
      if (i > 0) {
        const prev = s[i - 1];
        if (prev !== undefined) timeRatios.push((cur.totalMs / prev.totalMs).toFixed(2));
      }
    }
    console.log(
      `${scenario}: time-ratio ${timeRatios.join(", ")}  |  reads/note ${readPerNote.join(", ")}`,
    );
  }
}

void main();
