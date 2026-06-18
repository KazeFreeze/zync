/**
 * CallCounter — a transparent Proxy wrapper that counts how many times each method
 * of a port is called. Call counts only (no timing), so results are deterministic.
 *
 * Modelled on `PortProfiler.wrap()` in packages/plugin/src/profiling.ts — same
 * Proxy pattern, same async-safe counting (awaiting Promises before incrementing),
 * but stripped of all `performance.now()` usage so it lives here in @zync/core/testing
 * rather than the plugin (correct dependency direction: core must not import plugin).
 *
 * Usage:
 *   const counter = new CallCounter();
 *   const wrappedVault = counter.wrap(realVault);
 *   // ... exercise wrappedVault ...
 *   console.log(counter.count("read"));      // number of read() calls
 *   console.log(counter.count("writeAtomic")); // etc.
 */
export class CallCounter {
  private readonly counts = new Map<string, number>();

  /** Return a Proxy that forwards every call to `port` and counts per-method call completions. */
  wrap<T extends object>(port: T): T {
    return new Proxy(port, {
      get: (target, prop, receiver) => {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const method = String(prop);
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
          const out: unknown = fn.apply(target, args);
          if (out instanceof Promise) {
            // Count after the promise settles so the count reflects completed calls —
            // matching PortProfiler.wrap() semantics (record after await).
            return out.finally(() => {
              this.increment(method);
            });
          }
          this.increment(method);
          return out;
        };
      },
    });
  }

  /** How many times `method` has been called (0 if never called). */
  count(method: string): number {
    return this.counts.get(method) ?? 0;
  }

  /** Snapshot of all counts as a plain object (method → count). */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /** Reset all counts to zero. */
  reset(): void {
    this.counts.clear();
  }

  private increment(method: string): void {
    this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
  }
}
