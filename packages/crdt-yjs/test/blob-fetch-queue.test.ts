import { describe, it, expect } from "vitest";
import {
  BlobFetchQueue,
  BlobTransientError,
  BlobPermanentError,
  type MaterializeOutcome,
} from "@zync/core";
import type { VaultPath, Sha256 } from "@zync/core";
import { FakeClock } from "@zync/core/testing";

const p = (s: string): VaultPath => s as VaultPath;
const sha = (s: string): Sha256 => s as Sha256;

// A controllable materialize: records calls + concurrency, resolves when the test releases each path.
function controllable() {
  let inFlight = 0,
    peak = 0;
  const gates = new Map<string, () => void>();
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const materialize = (path: VaultPath, _expected: Sha256): Promise<MaterializeOutcome> => {
    calls.push(path);
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise<MaterializeOutcome>((resolve) => {
      gates.set(path, () => {
        inFlight--;
        resolve("written");
      });
    });
  };
  return { materialize, release: (path: string) => gates.get(path)?.(), peak: () => peak, calls };
}

function newQueue(c: ReturnType<typeof controllable>, concurrency = 2) {
  return new BlobFetchQueue({
    materialize: c.materialize,
    manifestEntries: () => [],
    clock: new FakeClock(),
    onFailure: () => undefined,
    concurrency,
    maxInFlightBytes: 1_000_000_000,
    maxRetries: 4,
    retryTickMs: 1_000_000,
  });
}

describe("BlobFetchQueue — concurrency + dedup", () => {
  it("never runs more than `concurrency` materializes at once", async () => {
    const c = controllable();
    const q = newQueue(c, 2);
    for (const name of ["a", "b", "c", "d"]) q.enqueue(p(name), sha(`s-${name}`), 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(c.peak()).toBeLessThanOrEqual(2);
    expect(c.calls.length).toBe(2);
    c.release("a");
    await Promise.resolve();
    await Promise.resolve();
    expect(c.calls.length).toBe(3);
    c.release("b");
    c.release("c");
    await Promise.resolve();
    await Promise.resolve(); // let b/c finish so "d" is dispatched (its gate exists) before release
    c.release("d");
    await q.whenDrained();
    expect(c.peak()).toBeLessThanOrEqual(2);
  });

  it("dedups a same-sha re-enqueue of an in-flight path", async () => {
    const c = controllable();
    const q = newQueue(c, 4);
    q.enqueue(p("a"), sha("s1"), 10);
    q.enqueue(p("a"), sha("s1"), 10);
    await Promise.resolve();
    expect(c.calls.filter((x) => x === "a").length).toBe(1);
    c.release("a");
    await q.whenDrained();
  });
});

describe("BlobFetchQueue — byte budget", () => {
  it("does not start a job that would exceed the in-flight byte budget", async () => {
    const c = controllable();
    const q = new BlobFetchQueue({
      materialize: c.materialize,
      manifestEntries: () => [],
      clock: new FakeClock(),
      onFailure: () => undefined,
      concurrency: 4,
      maxInFlightBytes: 100,
      maxRetries: 4,
      retryTickMs: 1e9,
    });
    q.enqueue(p("a"), sha("sa"), 60);
    q.enqueue(p("b"), sha("sb"), 60); // 60+60 > 100 -> b waits
    await Promise.resolve();
    await Promise.resolve();
    expect(c.calls).toEqual(["a"]);
    c.release("a");
    await Promise.resolve();
    await Promise.resolve();
    expect(c.calls).toEqual(["a", "b"]); // budget freed
    c.release("b");
    await q.whenDrained();
  });

  it("a single oversized blob proceeds alone (no deadlock)", async () => {
    const c = controllable();
    const q = new BlobFetchQueue({
      materialize: c.materialize,
      manifestEntries: () => [],
      clock: new FakeClock(),
      onFailure: () => undefined,
      concurrency: 4,
      maxInFlightBytes: 100,
      maxRetries: 4,
      retryTickMs: 1e9,
    });
    q.enqueue(p("big"), sha("sbig"), 9999); // > budget, but nothing in flight -> runs alone
    await Promise.resolve();
    expect(c.calls).toEqual(["big"]);
    c.release("big");
    await q.whenDrained();
  });
});

describe("BlobFetchQueue — typed retry + parking", () => {
  it("retries a transient error then succeeds; permanent parks immediately + reports failure", async () => {
    let attempts = 0;
    const failedReports: string[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const materialize = (path: VaultPath, _s: Sha256): Promise<MaterializeOutcome> => {
      if (path === p("flaky")) {
        attempts++;
        if (attempts < 2) return Promise.reject(new BlobTransientError({ sha: sha("x") }));
        return Promise.resolve("written");
      }
      return Promise.reject(new BlobPermanentError({ sha: sha("y"), reason: "413" }));
    };
    const q = new BlobFetchQueue({
      materialize,
      manifestEntries: () => [],
      clock: new FakeClock(),
      onFailure: (paths) => failedReports.push(paths.map(String)),
      concurrency: 4,
      maxInFlightBytes: 1e9,
      maxRetries: 4,
      retryTickMs: 1e9,
    });
    q.enqueue(p("perm"), sha("y"), 10);
    q.enqueue(p("flaky"), sha("x"), 10);
    await new Promise((r) => setTimeout(r, 50)); // let backoff retries run
    await q.whenSettled();
    expect(attempts).toBe(2); // flaky retried once then succeeded
    expect(failedReports.at(-1)).toEqual(["perm"]); // perm parked + reported
    expect(q.progress().failed).toBe(1);
  });
});

describe("BlobFetchQueue — heal tick + stop", () => {
  it("re-enqueues parked failures on the heal tick once the store recovers", async () => {
    let broken = true;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const materialize = (_p: VaultPath, _s: Sha256): Promise<MaterializeOutcome> => {
      if (broken) return Promise.reject(new BlobPermanentError({ sha: sha("z"), reason: "down" }));
      return Promise.resolve("written");
    };
    const q = new BlobFetchQueue({
      materialize,
      manifestEntries: () => [[p("x"), { sha256: sha("z"), size: 10, deviceId: "d" as never }]],
      clock: new FakeClock(),
      onFailure: () => undefined,
      concurrency: 4,
      maxInFlightBytes: 1e9,
      maxRetries: 0,
      retryTickMs: 20,
    });
    q.start();
    q.enqueue(p("x"), sha("z"), 10);
    await new Promise((r) => setTimeout(r, 30)); // first attempt parks
    expect(q.progress().failed).toBe(1);
    broken = false;
    await new Promise((r) => setTimeout(r, 40)); // heal tick re-enqueues -> succeeds
    await q.whenSettled();
    expect(q.progress().failed).toBe(0);
    q.stop();
  });

  it("a healed parked failure clears the aggregate failure report", async () => {
    let broken = true;
    const failedReports: string[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const materialize = (_p: VaultPath, _s: Sha256): Promise<MaterializeOutcome> => {
      if (broken) return Promise.reject(new BlobPermanentError({ sha: sha("z"), reason: "down" }));
      return Promise.resolve("written");
    };
    const q = new BlobFetchQueue({
      materialize,
      manifestEntries: () => [[p("x"), { sha256: sha("z"), size: 10, deviceId: "d" as never }]],
      clock: new FakeClock(),
      onFailure: (paths) => failedReports.push(paths.map(String)),
      concurrency: 4,
      maxInFlightBytes: 1e9,
      maxRetries: 0,
      retryTickMs: 20,
    });
    q.start();
    q.enqueue(p("x"), sha("z"), 10);
    await new Promise((r) => setTimeout(r, 30)); // first attempt parks
    expect(failedReports.at(-1)).toEqual(["x"]); // parked + reported
    expect(q.progress().failed).toBe(1);
    broken = false;
    await new Promise((r) => setTimeout(r, 40)); // heal tick re-enqueues -> succeeds
    await q.whenSettled();
    // The aggregate inbox item must resolve: onFailure([]) fires when the last failure heals.
    expect(failedReports.at(-1)).toEqual([]);
    expect(q.progress().failed).toBe(0);
    q.stop();
  });

  it("stop() during an in-flight fetch prevents a post-stop retry re-arm (transient)", async () => {
    let calls = 0;
    let rejectInFlight: ((e: unknown) => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const materialize = (_p: VaultPath, _s: Sha256): Promise<MaterializeOutcome> =>
      new Promise<MaterializeOutcome>((_res, rej) => {
        calls++;
        rejectInFlight = rej;
      });
    const q = new BlobFetchQueue({
      materialize,
      manifestEntries: () => [],
      clock: new FakeClock(),
      onFailure: () => undefined,
      concurrency: 4,
      maxInFlightBytes: 1e9,
      maxRetries: 4,
      retryTickMs: 1e9,
    });
    q.enqueue(p("a"), sha("sa"), 10);
    await Promise.resolve();
    expect(calls).toBe(1); // "a" is in-flight
    q.stop();
    rejectInFlight?.(new BlobTransientError({ sha: sha("sa") })); // fails transiently AFTER stop
    await new Promise((r) => setTimeout(r, 350)); // longer than the ~200-300ms backoff would be
    expect(calls).toBe(1); // NO retry re-dispatched after stop
    await q.whenSettled(); // queue settled cleanly — no dangling timers
  });

  it("a parked failure healing in-flight after stop() does NOT call onFailure", async () => {
    const failedReports: string[][] = [];
    let calls = 0;
    let resolveSecond: ((o: MaterializeOutcome) => void) | undefined;
    // First attempt parks (permanent + maxRetries 0); the second is a controllable in-flight promise.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const materialize = (_p: VaultPath, _s: Sha256): Promise<MaterializeOutcome> => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new BlobPermanentError({ sha: sha("x"), reason: "down" }));
      }
      return new Promise<MaterializeOutcome>((resolve) => {
        resolveSecond = resolve;
      });
    };
    const q = new BlobFetchQueue({
      materialize,
      manifestEntries: () => [],
      clock: new FakeClock(),
      onFailure: (paths) => failedReports.push(paths.map(String)),
      concurrency: 4,
      maxInFlightBytes: 1e9,
      maxRetries: 0,
      retryTickMs: 1e9,
    });
    q.start();
    q.enqueue(p("x"), sha("x"), 10);
    await new Promise((r) => setTimeout(r, 10)); // first attempt parks
    expect(failedReports.at(-1)).toEqual(["x"]); // parked + reported
    // Heal: re-enqueue x so the SECOND materialize is in-flight (not yet resolved).
    q.enqueue(p("x"), sha("x"), 10);
    await new Promise((r) => setTimeout(r, 10)); // let the second materialize start
    expect(calls).toBe(2); // second attempt is in-flight, awaiting resolveSecond
    const before = failedReports.length; // snapshot the report count before shutdown
    q.stop(); // tear down WITHOUT cancelling the in-flight #run
    resolveSecond?.("written"); // the heal lands AFTER stop()
    await new Promise((r) => setTimeout(r, 10)); // flush micro + macrotasks
    // Without the #stopped guard, #run's success path fires onFailure([]) at a torn-down consumer.
    expect(failedReports.length).toBe(before);
  });
});

describe("BlobFetchQueue — stale retry vs newer-sha re-enqueue", () => {
  it("a stale retry timer does not clobber a newer-sha re-enqueue", async () => {
    const xShas: string[] = [];
    const blockerGates = new Map<string, () => void>();
    const materialize = (path: VaultPath, expected: Sha256): Promise<MaterializeOutcome> => {
      if (path === p("x")) {
        xShas.push(String(expected));
        // The stale sha keeps failing transiently; the newer sha succeeds.
        if (String(expected) === "s1") {
          return Promise.reject(new BlobTransientError({ sha: sha("s1") }));
        }
        return Promise.resolve("written");
      }
      // Blockers occupy a concurrency slot until the test releases them.
      return new Promise<MaterializeOutcome>((resolve) => {
        blockerGates.set(String(path), () => {
          resolve("written");
        });
      });
    };
    const q = new BlobFetchQueue({
      materialize,
      manifestEntries: () => [],
      clock: new FakeClock(),
      onFailure: () => undefined,
      concurrency: 2,
      maxInFlightBytes: 1e9,
      maxRetries: 4,
      retryTickMs: 1e9,
    });
    // x@s1 runs first, fails transiently -> arms a retry timer (NOT in #queued).
    q.enqueue(p("x"), sha("s1"), 10);
    await new Promise((r) => setTimeout(r, 10));
    expect(xShas).toEqual(["s1"]);
    // Occupy BOTH concurrency slots so the next x re-target cannot dispatch.
    q.enqueue(p("blocker1"), sha("sb1"), 10);
    q.enqueue(p("blocker2"), sha("sb2"), 10);
    await new Promise((r) => setTimeout(r, 10));
    // The manifest moved x -> s2; re-enqueue while the cap is full -> x@s2 sits QUEUED.
    q.enqueue(p("x"), sha("s2"), 10);
    // Wait past the ~200ms backoff: the stale x@s1 retry timer would fire here.
    await new Promise((r) => setTimeout(r, 260));
    // Free one slot -> x dispatches. It MUST target s2 (newer), never the stale s1.
    blockerGates.get("blocker1")?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(xShas.at(-1)).toBe("s2"); // BUG: stale timer clobbers x@s2 -> would be "s1"
    blockerGates.get("blocker2")?.();
    await q.whenSettled();
    expect(xShas.filter((s) => s === "s2").length).toBe(1); // s2 materialized exactly once
    expect(q.progress().failed).toBe(0); // x is NOT parked — it healed via s2
  });
});
