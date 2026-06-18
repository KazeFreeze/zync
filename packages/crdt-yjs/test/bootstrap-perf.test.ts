import { describe, it, expect } from "vitest";
import { SyncEngine } from "@zync/core";
import type { EnginePorts, EngineConfig, DeviceId, IdentityPort, VaultPath } from "@zync/core";
import {
  FakeVault,
  FakeClock,
  FakeBlobStore,
  FakeDocStore,
  MemEngineState,
  InProcessBus,
} from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";

const path = (s: string): VaultPath => s as VaultPath;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const identity = (id: string): IdentityPort => ({
  deviceId: () => id as DeviceId,
  deviceName: () => id,
});

/**
 * A FakeVault that counts read() calls — the metric the on-device profiler measures. `burstReads`
 * counts reads of the SETTLED note set ("burst/") specifically: that is the O(n^2) invariant under
 * test (post-seed passes must not re-scan the settled files). `reads` (all paths) also picks up the
 * per-pass base-record reads + each new note's own reads, which are unrelated O(1)/pass overhead.
 */
class CountingVault extends FakeVault {
  reads = 0;
  burstReads = 0;
  override read(p: VaultPath): Promise<Uint8Array | null> {
    this.reads++;
    if (p.startsWith("burst/")) this.burstReads++;
    return super.read(p);
  }
}

function makeEngine(bus: InProcessBus, id: string, vault: FakeVault): SyncEngine {
  const ports: EnginePorts = {
    vault,
    crdt: new YjsCrdtProvider(),
    transport: bus.connect(),
    blobs: new FakeBlobStore(),
    docStore: new FakeDocStore(),
    clock: new FakeClock(),
    identity: identity(id),
    engineState: new MemEngineState(),
  };
  const config: EngineConfig = {
    configDir: ".obsidian",
    maxProseBytes: 1_000_000,
    substrate: "yjs",
    stampDebounceMs: 0,
  };
  return new SyncEngine(ports, config);
}

const burstCount = async (v: FakeVault): Promise<number> =>
  (await v.list()).filter(({ path: p }) => p.startsWith("burst/")).length;
const pingCount = async (v: FakeVault): Promise<number> =>
  (await v.list()).filter(({ path: p }) => p.startsWith("ping/")).length;

describe("bootstrap-perf: disk-hash cache", () => {
  it("post-seed observe passes do NOT re-read settled files (O(n) guard)", async () => {
    const bus = new InProcessBus();
    const av = new FakeVault();
    const bv = new CountingVault();
    const a = makeEngine(bus, "dev-a", av);
    const b = makeEngine(bus, "dev-b", bv);
    await a.start();
    await b.start();

    // Seed N notes on A and fully converge B (everything materialized + settled).
    const N = 40;
    for (let i = 0; i < N; i++) {
      await av.writeAtomic(path(`burst/n${String(i)}.md`), utf8(`note ${String(i)} body`));
    }
    for (let i = 0; i < 30; i++) {
      await a.waitConverged();
      await b.waitConverged();
      if ((await a.pendingDocs()).length === 0 && (await b.pendingDocs()).length === 0) break;
    }
    expect(await burstCount(bv)).toBe(N);

    // Now drive M DISCRETE observe-driven reconcile passes on B by creating unrelated notes on A.
    // Each echoes an index change -> B runs the full catch-up/structural/settle chain. The O(n^2) bug
    // re-read ALL N settled "burst/" files on EVERY such pass; the cache must serve them from memory.
    // Measure with whenIdle ONLY (never waitConverged on B during the window -- pendingDocs reads
    // fresh BY DESIGN and would pollute the count).
    bv.reads = 0;
    bv.burstReads = 0;
    const M = 10;
    for (let i = 0; i < M; i++) {
      await av.writeAtomic(path(`ping/p${String(i)}.md`), utf8(`ping ${String(i)}`));
      await a.waitConverged(); // A pushes the ping; the relay echoes the index change to B
      const want = i + 1;
      for (let k = 0; k < 200 && (await pingCount(bv)) < want; k++) {
        await b.whenIdle(); // B's observe-driven coalesced pass(es) run (no pendingDocs reads)
        if ((await pingCount(bv)) < want) await new Promise((r) => setTimeout(r, 2));
      }
    }
    expect(await pingCount(bv)).toBe(M); // sanity: every ping materialized via the observe path

    // The M passes must NOT have re-read the N settled "burst/" files. Without the cache each pass
    // re-scans all N (~M*N burst reads, hundreds); with the cache they are served from memory, so the
    // settled set is read far less than even ONE full scan. (We assert on burstReads, not the total:
    // the new ping notes' own reads + per-pass base-record reads are unrelated O(1)/pass overhead.)
    expect(bv.burstReads).toBeLessThan(N);

    await a.stop();
    await b.stop();
  });

  // End-to-end no-clobber: an external disk edit on B, then an observe-driven reconcile, must converge
  // to the edit (never revert it). NOTE: the cache-never-authorizes-a-write guarantee is STRUCTURAL --
  // materialize's write path always re-reads disk fresh (see `materializeLiveDiskContent` in engine.ts;
  // verified by code inspection). The in-process harness cannot deterministically reproduce the timing
  // race where materialize beats ingest, so this test guards the property end-to-end rather than
  // isolating the anti-clobber line; the on-device run is the timing-faithful check.
  it("an external edit survives an observe-driven reconcile (end-to-end no-clobber)", async () => {
    const bus = new InProcessBus();
    const av = new FakeVault();
    const bv = new FakeVault();
    const a = makeEngine(bus, "dev-a", av);
    const b = makeEngine(bus, "dev-b", bv);
    await a.start();
    await b.start();

    const A_MD = path("a.md");
    await av.writeAtomic(A_MD, utf8("v1"));
    for (let i = 0; i < 20; i++) {
      await a.waitConverged();
      await b.waitConverged();
      if ((await a.pendingDocs()).length === 0 && (await b.pendingDocs()).length === 0) break;
    }
    const read = async (v: FakeVault): Promise<string | null> => {
      const x = await v.read(A_MD);
      return x === null ? null : decode(x);
    };
    expect(await read(bv)).toBe("v1");

    // EXTERNAL edit on B's disk (emits a modify event -> onVaultEvent forgets the cache + ingests),
    // plus unrelated index churn on A to drive B's observe reconcile. B must NOT revert a.md to "v1"
    // (the cache must never authorize clobbering the newer on-disk edit) -- append => clean 3-way.
    await bv.writeAtomic(A_MD, utf8("v1\nv2-external"));
    await av.writeAtomic(path("unrelated.md"), utf8("x"));
    for (let i = 0; i < 20; i++) {
      await a.waitConverged();
      await b.waitConverged();
      if ((await a.pendingDocs()).length === 0 && (await b.pendingDocs()).length === 0) break;
    }

    const finalB = await read(bv);
    expect(finalB).not.toBe("v1"); // never clobbered back to the pre-edit content
    expect(finalB).toContain("v2-external"); // the external edit survived
    expect(await read(av)).toContain("v2-external"); // and propagated to A

    await a.stop();
    await b.stop();
  });
});
