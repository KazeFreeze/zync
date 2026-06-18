import { describe, it, expect } from "vitest";
import { DiskHashCache } from "./disk-hash-cache.js";
import { sha256OfBytes } from "../hash.js";
import type { VaultPath } from "../ports.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const P = "n.md" as VaultPath;

/** A read fn backed by a mutable map, counting calls. */
function backing(initial: Record<string, string>) {
  const files = new Map<string, Uint8Array>(Object.entries(initial).map(([k, v]) => [k, utf8(v)]));
  let reads = 0;
  return {
    files,
    get reads() {
      return reads;
    },
    read: (p: VaultPath): Promise<Uint8Array | null> => {
      reads++;
      return Promise.resolve(files.get(p) ?? null);
    },
  };
}

function makeCache(b: ReturnType<typeof backing>): DiskHashCache {
  return new DiskHashCache({ read: b.read, hashBytes: (bytes) => sha256OfBytes(bytes) });
}

describe("DiskHashCache", () => {
  it("reads through on a miss, then serves the cached hash without re-reading", async () => {
    const b = backing({ "n.md": "hello" });
    const cache = makeCache(b);
    const want = await sha256OfBytes(utf8("hello"));
    expect(await cache.hash(P)).toBe(want);
    expect(await cache.hash(P)).toBe(want);
    expect(b.reads).toBe(1); // second call was a cache hit
  });

  it("caches a confirmed-absent file as null (no re-read)", async () => {
    const b = backing({});
    const cache = makeCache(b);
    expect(await cache.hash(P)).toBeNull();
    expect(await cache.hash(P)).toBeNull();
    expect(b.reads).toBe(1);
  });

  it("note() warm-sets a known hash, served without any read", async () => {
    const b = backing({ "n.md": "hello" });
    const cache = makeCache(b);
    const h = await sha256OfBytes(utf8("v2"));
    cache.note(P, h);
    expect(await cache.hash(P)).toBe(h);
    expect(b.reads).toBe(0); // never read disk
  });

  it("note(path, null) records a known-removed path, served as null without a read", async () => {
    // The remove path the engine's structuralVault wrapper takes: note the path absent on vault.remove.
    const b = backing({ "n.md": "still on disk" });
    const cache = makeCache(b);
    cache.note(P, null);
    expect(await cache.hash(P)).toBeNull();
    expect(b.reads).toBe(0); // never read disk despite the stale file still being present
  });

  it("forget() drops the memo so the next hash() re-reads", async () => {
    const b = backing({ "n.md": "v1" });
    const cache = makeCache(b);
    await cache.hash(P);
    b.files.set("n.md", utf8("v2")); // out-of-band change
    cache.forget(P);
    expect(await cache.hash(P)).toBe(await sha256OfBytes(utf8("v2")));
    expect(b.reads).toBe(2);
  });

  it("does NOT memoize a value invalidated mid-read (epoch guard)", async () => {
    // A read whose promise we resolve manually, so we can forget() while it is in flight.
    const pending: ((b: Uint8Array | null) => void)[] = [];
    let reads = 0;
    const cache = new DiskHashCache({
      read: () => {
        reads++;
        return new Promise<Uint8Array | null>((res) => pending.push(res));
      },
      hashBytes: (bytes) => sha256OfBytes(bytes),
    });
    const inflight = cache.hash(P); // miss -> read pending (the first queued resolver)
    cache.forget(P); // invalidation races in DURING the read
    const resolveStale = pending.shift();
    if (resolveStale === undefined) throw new Error("expected a pending read");
    resolveStale(utf8("stale")); // read resolves with the now-stale value
    await inflight;
    // The raced-out value must NOT have been memoized -> next hash() reads again.
    const next = cache.hash(P);
    const resolveFresh = pending.shift();
    if (resolveFresh === undefined) throw new Error("expected a second read");
    resolveFresh(utf8("fresh"));
    expect(await next).toBe(await sha256OfBytes(utf8("fresh")));
    expect(reads).toBe(2);
  });
});
