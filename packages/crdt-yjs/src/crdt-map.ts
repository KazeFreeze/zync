import type * as Y from "yjs";
import type { CrdtMap, Unsubscribe } from "@zync/core";

/**
 * `CrdtMap<V>` over a `Y.Map`. `Y.Map` already provides per-key LWW register
 * semantics, so `set`/`get`/`delete` delegate directly; concurrent `set`s on the
 * same key converge by Yjs's deterministic LWW.
 *
 * ORIGIN TAGGING (Task 13b fix): a bare `ymap.set` runs in a transaction with a
 * `null` origin, which the engine's {@link CrdtDoc.onUpdate} maps to `"remote"` —
 * indistinguishable from an update the transport APPLIED from a peer. The transport's
 * loop-breaker then drops it, so index/inbox map writes (tree stamps, tombstones,
 * inbox entries) never relayed live. We wrap every mutation in an explicit
 * `"local-bridge"`-origin transaction so it reads as a genuine local change and the
 * transport relays it. (Peer-applied updates still carry `"remote"` and are skipped.)
 */
export class YjsCrdtMap<V> implements CrdtMap<V> {
  constructor(private readonly ymap: Y.Map<V>) {}

  get(key: string): V | undefined {
    return this.ymap.get(key);
  }

  set(key: string, value: V): void {
    this.transact(() => {
      this.ymap.set(key, value);
    });
  }

  delete(key: string): void {
    this.transact(() => {
      this.ymap.delete(key);
    });
  }

  /** Run `fn` in a `"local-bridge"`-origin transaction when the map is doc-bound. */
  private transact(fn: () => void): void {
    const doc = this.ymap.doc;
    if (doc === null) {
      fn();
      return;
    }
    doc.transact(fn, "local-bridge");
  }

  entries(): [string, V][] {
    return [...this.ymap.entries()];
  }

  observe(cb: (changedKeys: string[]) => void): Unsubscribe {
    const handler = (e: Y.YMapEvent<V>): void => {
      // Yjs types `keysChanged` as `Set<any>`; map keys are strings.
      const changed = e.keysChanged as Set<string>;
      cb([...changed]);
    };
    this.ymap.observe(handler);
    return () => {
      this.ymap.unobserve(handler);
    };
  }
}
