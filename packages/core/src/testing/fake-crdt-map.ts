import type { CrdtMap, Unsubscribe } from "../ports.js";

/**
 * In-memory {@link CrdtMap} for core-side logic tests — a plain `Map` with an
 * `observe` hook that fires the changed key on every `set`/`delete`.
 *
 * SINGLE-REPLICA ONLY: this fake has NO merge/LWW semantics. It exercises the
 * shape of code built on a `CrdtMap` (e.g. {@link IndexDoc}), but it cannot prove
 * convergence. The real per-key LWW behaviour is verified against `YjsCrdtMap` in
 * `packages/crdt-yjs/test/index-doc-convergence.test.ts`.
 */
export class FakeCrdtMap<V> implements CrdtMap<V> {
  private readonly store = new Map<string, V>();
  private readonly listeners = new Set<(changedKeys: string[]) => void>();

  get(key: string): V | undefined {
    return this.store.get(key);
  }

  set(key: string, value: V): void {
    this.store.set(key, value);
    this.emit(key);
  }

  delete(key: string): void {
    if (this.store.delete(key)) this.emit(key);
  }

  entries(): [string, V][] {
    return [...this.store.entries()];
  }

  observe(cb: (changedKeys: string[]) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(key: string): void {
    for (const l of this.listeners) l([key]);
  }
}
