/**
 * PortProfiler — transparent timing wrapper for the engine's I/O ports, to ATTRIBUTE the on-device
 * first-sync cost across the layers a headless benchmark cannot model. `harness:scale` (real relay +
 * node FS stores) measures the engine + relay + FS I/O, but NOT the plugin's real IndexedDB
 * (`IdbDocStore`/`IdbEngineState`) or the Obsidian DataAdapter (`ObsidianVaultPort`) — and the plugin's
 * ~12x slowdown over the harness lives in exactly those. This splits IDB vs DataAdapter on real Electron.
 *
 * `wrap(name, port)` returns a Proxy that forwards every call to the real port but records wall-time and
 * call count per `name.method` (awaiting async results before recording). Overhead is a Proxy get + one
 * `performance.now()` pair + a Map update per port call — microseconds against the IDB/file I/O being
 * measured. `report()` formats the buckets (busiest first) + per-layer totals for a one-shot dump after
 * the first sync settles (the "Zync: dump bootstrap profile" command).
 *
 * KNOWN LIMITATION: the relay round-trip wait lives on the `AttachedDoc` handle (`synced()`/`acked()`),
 * NOT on a transport-port method, so it is NOT captured here — use the `harness:scale` number (~78s) for
 * the relay share. This profiler's job is the IDB-vs-DataAdapter split the harness cannot give.
 */
export interface ProfileBucket {
  calls: number;
  ms: number;
}

export class PortProfiler {
  private readonly buckets = new Map<string, ProfileBucket>();

  /** Wrap a port so every method call is timed + counted under `name.method`. Transparent to callers. */
  wrap<T extends object>(name: string, port: T): T {
    return new Proxy(port, {
      get: (target, prop, receiver) => {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const key = `${name}.${String(prop)}`;
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
          const t0 = performance.now();
          const out: unknown = fn.apply(target, args);
          if (out instanceof Promise) {
            return out.finally(() => {
              this.record(key, performance.now() - t0);
            });
          }
          this.record(key, performance.now() - t0);
          return out;
        };
      },
    });
  }

  private record(key: string, ms: number): void {
    const b = this.buckets.get(key) ?? { calls: 0, ms: 0 };
    b.calls += 1;
    b.ms += ms;
    this.buckets.set(key, b);
  }

  /** A human-readable table, busiest bucket first, plus the per-layer totals (IDB vs DataAdapter). */
  report(): string {
    const rows = [...this.buckets.entries()].sort((a, b) => b[1].ms - a[1].ms);
    if (rows.length === 0) return "Zync profile: no port calls recorded yet.";
    const lines = [
      "Zync bootstrap profile (port wall-time; relay round-trip NOT included — see harness:scale ~78s):",
    ];
    for (const [key, b] of rows) {
      const perCall = (b.ms / Math.max(1, b.calls)).toFixed(2);
      lines.push(
        `  ${key.padEnd(30)} ${b.ms.toFixed(0).padStart(9)}ms  ${String(b.calls).padStart(7)} calls  ${perCall}ms/call`,
      );
    }
    const groupMs = (prefixes: string[]): number =>
      rows
        .filter(([k]) => prefixes.some((p) => k.startsWith(p)))
        .reduce((sum, [, b]) => sum + b.ms, 0);
    lines.push("");
    lines.push(
      `  IDB total (docStore + engineState): ${groupMs(["docStore.", "engineState."]).toFixed(0)}ms`,
    );
    lines.push(`  DataAdapter total (vault):          ${groupMs(["vault."]).toFixed(0)}ms`);
    return lines.join("\n");
  }
}
