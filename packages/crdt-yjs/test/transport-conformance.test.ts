import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CrdtProvider, DocId, TextEdit, TransportPort } from "@zync/core";
import { ClosedError, InProcessBus, InProcessTransport } from "@zync/core/testing";
import { createRelay } from "@zync/server/relay";
import type { RelayHandle } from "@zync/server/relay";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { YjsCrdtProvider } from "../src/index.js";
import { HocuspocusTransport } from "../src/transport-hocuspocus.js";

const id = (s: string): DocId => s as DocId;
const ins = (at: number, insert: string): TextEdit => ({ at, delete: 0, insert });

/**
 * Mint a process-unique DocId. The LIVE relay is booted once and SHARED across every test in the
 * suite, and it RETAINS per-doc state between tests — so reusing a fixed docId would let one test's
 * content leak into the next (e.g. a stale "synced" resolving an offline-attach early). A fresh id
 * per test keeps the live runs independent and deterministic. (Harmless for InProcess too.)
 */
let docSeq = 0;
const freshDocId = (): DocId => id(`doc-${String(docSeq++)}`);

/**
 * Poll `cond()` until true or the bounded deadline elapses, then return its final value. Resolves
 * IMMEDIATELY (first tick) when already true — so the in-process (synchronous) substrate never
 * pays a timer, while the live relay's async convergence is awaited robustly (no bare sleeps).
 */
async function pollUntil(cond: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

/**
 * Abstract conformance substrate: two real {@link TransportPort}s linked through one relay (an
 * {@link InProcessBus} or the live Hocuspocus relay), a {@link CrdtProvider} to mint docs, and an
 * OFFLINE/ONLINE lever for `t2`. The lever abstracts over InProcess `goOffline/goOnline` vs the
 * live socket `disconnect()/connect()` — the only transport-specific seam the shared block needs.
 */
interface ConformanceHarness {
  readonly provider: CrdtProvider;
  readonly t1: TransportPort;
  readonly t2: TransportPort;
  /** Sever t2's connection (whole-socket). */
  goOffline(): void;
  /** Restore t2's connection; attached docs auto-resync WITHOUT re-attach. */
  goOnline(): void;
  cleanup(): Promise<void>;
}

/**
 * Provider-parameterized transport-conformance suite. Written against the `@zync/core` ports + an
 * abstract OFFLINE/ONLINE lever only — no Yjs internals, no InProcess-specific controls — so the
 * SAME contract checks run against BOTH the {@link InProcessTransport} fake AND the LIVE Hocuspocus
 * relay (0b-3). Convergence is asserted via bounded polling, never fixed sleeps, so the live run is
 * deterministic under the forks pool.
 */
export function runTransportConformance(label: string, make: () => ConformanceHarness): void {
  describe(`TransportPort conformance [${label}]`, () => {
    let harness: ConformanceHarness | undefined;

    afterEach(async () => {
      await harness?.cleanup();
      harness = undefined;
    });

    it("converges: edits relay both directions over the bus", async () => {
      harness = make();
      const { provider, t1, t2 } = harness;
      const docId = freshDocId();

      const docA = provider.createDoc(docId);
      const docB = provider.createDoc(docId);
      const a = t1.attach(docA);
      const b = t2.attach(docB);
      await Promise.all([a.synced(), b.synced()]);

      docA.applyEdits([ins(0, "hello")], "local-editor");
      expect(await pollUntil(() => docB.getText() === "hello")).toBe(true);

      docB.applyEdits([ins(5, " world")], "local-editor");
      expect(await pollUntil(() => docA.getText() === "hello world")).toBe(true);
      expect(await pollUntil(() => docB.getText() === "hello world")).toBe(true);

      a.detach();
      b.detach();
      docA.destroy();
      docB.destroy();
    });

    it("offline-attach: synced() pends, auto-resync on goOnline carries queued edits", async () => {
      harness = make();
      const { provider, t1, t2 } = harness;
      const docId = freshDocId();

      const docA = provider.createDoc(docId);
      const a = t1.attach(docA);
      await a.synced();

      // Attach docB on the offline transport: attach returns immediately, synced() pends.
      // (We don't poll for `status()==="offline"`: a live socket dropped mid-connection-attempt may
      // report "connecting", and the offline CONTRACT is about synced() pending — asserted next —
      // not the status string. `t2` is read for parity with the live harness; touch it to satisfy
      // no-unused without weakening the test.)
      void t2.status();
      harness.goOffline();
      const docB = provider.createDoc(docId);
      const b = t2.attach(docB);

      let resolved = false;
      void b.synced().then(() => (resolved = true));
      // Give any (wrong) resolution real time to surface; a microtask is enough for InProcess,
      // and a short tick rules out a spurious live `synced` while the socket is down.
      await pollUntil(() => resolved, 150);
      expect(resolved).toBe(false);

      // Edit on A while B is offline — not delivered yet.
      docA.applyEdits([ins(0, "offline-edit")], "local-editor");
      expect(docB.getText()).toBe("");

      // Reconnect → auto-resync resolves synced() and carries A's text to B.
      harness.goOnline();
      await b.synced();
      expect(resolved).toBe(true);
      expect(await pollUntil(() => docB.getText() === "offline-edit")).toBe(true);

      a.detach();
      b.detach();
      docA.destroy();
      docB.destroy();
    });

    it("no echo: a relayed remote update converges on B without bouncing back to the sender", async () => {
      harness = make();
      const { provider, t1, t2 } = harness;
      const docId = freshDocId();

      const docA = provider.createDoc(docId);
      const docB = provider.createDoc(docId);
      const a = t1.attach(docA);
      const b = t2.attach(docB);
      await Promise.all([a.synced(), b.synced()]);

      // A's edit relays to B. A must NOT mutate from a bounced-back echo of its own update, and once
      // both converge the state must be QUIESCENT — an echo loop would keep re-applying / diverge.
      // (The precise "A received ZERO inbound applies" invariant is asserted in the InProcess-only
      // addendum below: the live relay applies updates straight to the Y.Doc, bypassing
      // CrdtDoc.applyUpdate, so an apply-counter is not observable on the live substrate.)
      docA.applyEdits([ins(0, "x")], "local-editor");
      expect(await pollUntil(() => docB.getText() === "x")).toBe(true);

      // Settle window: if an echo storm existed, A or B would drift away from "x" here.
      await pollUntil(() => false, 100);
      expect(docA.getText()).toBe("x");
      expect(docB.getText()).toBe("x");

      a.detach();
      b.detach();
      docA.destroy();
      docB.destroy();
    });

    it("acked(): resolves once the relay has received the queued local update", async () => {
      harness = make();
      const { provider, t1 } = harness;
      const docId = freshDocId();

      const docA = provider.createDoc(docId);
      const a = t1.attach(docA);
      await a.synced();

      // No unsynced changes yet → ack resolves promptly.
      await a.acked();

      // Push a local edit; acked() must resolve once the relay confirms receipt (RECEIVED+MERGED,
      // not fsync). Bounded await — the live relay acks asynchronously, InProcess synchronously.
      docA.applyEdits([ins(0, "acked-content")], "local-editor");
      let acked = false;
      void a.acked().then(() => (acked = true));
      expect(await pollUntil(() => acked)).toBe(true);

      a.detach();
      docA.destroy();
    });

    it("close() rejects in-flight synced() with ClosedError", async () => {
      harness = make();
      const { provider, t2 } = harness;

      harness.goOffline();
      const docB = provider.createDoc(freshDocId());
      const b = t2.attach(docB); // synced() pends — offline, never exchanged
      const pending = b.synced();
      // Guard against an unhandled-rejection warning if close() rejects before the assertion awaits.
      pending.catch(() => undefined);

      await t2.close();
      await expect(pending).rejects.toBeInstanceOf(ClosedError);

      docB.destroy();
    });
  });
}

// ── InProcess-only addendum: per-doc partition/heal ─────────────────────────────────────────────
//
// A real WebSocket socket cannot partition a SINGLE doc while leaving others connected — that
// capability is exercised by `docker network disconnect` in the later Docker harness. The
// InProcessTransport models it directly via `partition(id)`/`heal(id)`, so this contract point
// lives here as an InProcess-only addendum (the shared block above covers the whole-socket
// offline/online path that DOES have a live analogue).
describe("TransportPort conformance [in-process] — per-doc partition (InProcess-only)", () => {
  let bus: InProcessBus | undefined;
  let t1: InProcessTransport | undefined;
  let t2: InProcessTransport | undefined;

  afterEach(async () => {
    await t1?.close();
    await t2?.close();
    bus = undefined;
    t1 = undefined;
    t2 = undefined;
  });

  it("partition: synced() stays resolved but edits pend; heal auto-resyncs (no re-attach)", async () => {
    bus = new InProcessBus();
    t1 = bus.connect();
    t2 = bus.connect();
    const provider = new YjsCrdtProvider();

    const docA = provider.createDoc(id("doc"));
    const docB = provider.createDoc(id("doc"));
    const a = t1.attach(docA);
    const b = t2.attach(docB);
    await Promise.all([a.synced(), b.synced()]);

    // Partition just this doc on t2; an edit on A must NOT reach B.
    t2.partition(id("doc"));
    docA.applyEdits([ins(0, "during-partition")], "local-editor");
    expect(docB.getText()).toBe("");

    // Heal → B converges with NO re-attach.
    t2.heal(id("doc"));
    expect(docB.getText()).toBe("during-partition");

    a.detach();
    b.detach();
    docA.destroy();
    docB.destroy();
  });

  it("no echo (precise apply count): sender receives ZERO inbound applies on its own edit", async () => {
    bus = new InProcessBus();
    t1 = bus.connect();
    t2 = bus.connect();
    const provider = new YjsCrdtProvider();

    const docA = provider.createDoc(id("doc"));
    const docB = provider.createDoc(id("doc"));
    const a = t1.attach(docA);
    const b = t2.attach(docB);
    await Promise.all([a.synced(), b.synced()]);

    // Count INBOUND applies on each doc. Yjs dedupes by content, so an echoed update would not fire
    // `onUpdate` — but it WOULD re-invoke `applyUpdate`. Counting applies is the load-bearing signal
    // that the loop-breaker actually suppresses the bounce-back. The InProcessBus routes relayed
    // updates through `CrdtDoc.applyUpdate`, so the counter is observable here (it is NOT on the live
    // substrate, where the relay applies straight to the Y.Doc — see the shared no-echo test).
    let aApplies = 0;
    let bApplies = 0;
    const rawApplyA = docA.applyUpdate.bind(docA);
    const rawApplyB = docB.applyUpdate.bind(docB);
    docA.applyUpdate = (u, o) => {
      aApplies += 1;
      rawApplyA(u, o);
    };
    docB.applyUpdate = (u, o) => {
      bApplies += 1;
      rawApplyB(u, o);
    };

    docA.applyEdits([ins(0, "x")], "local-editor");

    // B received exactly one relayed update; A received ZERO (no bounce-back). Text is quiescent.
    expect(bApplies).toBe(1);
    expect(aApplies).toBe(0);
    expect(docA.getText()).toBe("x");
    expect(docB.getText()).toBe("x");

    a.detach();
    b.detach();
    docA.destroy();
    docB.destroy();
  });
});

// ── Substrate 1: in-process fake ────────────────────────────────────────────────────────────────
runTransportConformance("in-process", () => {
  const bus = new InProcessBus();
  const t1 = bus.connect();
  const t2 = bus.connect();
  return {
    provider: new YjsCrdtProvider(),
    t1,
    t2,
    goOffline: () => {
      t2.goOffline();
    },
    goOnline: () => {
      t2.goOnline();
    },
    cleanup: async () => {
      await t1.close();
      await t2.close();
    },
  };
});

// ── Substrate 2: LIVE relay ─────────────────────────────────────────────────────────────────────
//
// Boots a real Hocuspocus relay in-process on an ephemeral port and runs the SAME shared contract
// against two real HocuspocusTransports sharing it (real YjsCrdtProvider, Node's global WebSocket —
// no polyfill needed on Node 22+). This de-risks the real wire BEFORE the Docker harness, proving
// the live transport honors the same offline/reconnect/no-echo/close contract as the fake.
//
// OFFLINE/ONLINE lever: a live socket has no per-doc partition, so the lever is the SHARED socket's
// `disconnect()/connect()` (the transport multiplexes every doc over it — see transport-hocuspocus).
// The socket is a `private` field of HocuspocusTransport; reaching it is a deliberate TEST seam (it
// simulates the OS dropping the connection, an external event, not a transport API), so we read it
// through a typed structural view rather than widening the production surface.
const LIVE_TOKEN = "dev-static-token";

interface HasSocket {
  readonly socket: HocuspocusProviderWebsocket;
}

/** Read a HocuspocusTransport's shared socket as a test seam (see substrate comment). */
function socketOf(t: HocuspocusTransport): HocuspocusProviderWebsocket {
  return (t as unknown as HasSocket).socket;
}

/** Grab an ephemeral free port by opening then closing a throwaway HocuspocusProviderWebsocket's host. */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not determine ephemeral port"));
        return;
      }
      const { port } = addr;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

describe("live Hocuspocus relay", () => {
  let relay: RelayHandle | undefined;
  let snapshotDir: string | undefined;
  let url: string | undefined;

  beforeAll(async () => {
    const port = await freePort();
    snapshotDir = mkdtempSync(join(tmpdir(), "zync-live-transport-"));
    url = `ws://127.0.0.1:${String(port)}`;
    relay = createRelay({ port, token: LIVE_TOKEN, snapshotDir });
    await relay.hocuspocus.listen();
  });

  afterAll(async () => {
    // Wait (bounded) for every client connection to drain before tearing the relay down: a client
    // socket still open at destroy() triggers a final onStoreDocument, which — if the snapshot dir
    // is already gone — logs a (caught, non-fatal) ENOENT. Draining first keeps teardown silent and
    // proves no transport handle leaked past its afterEach cleanup.
    const hp = relay?.hocuspocus;
    if (hp !== undefined) {
      const deadline = Date.now() + 3000;
      while (hp.getConnectionsCount() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    await relay?.close();
    relay = undefined;
    if (snapshotDir !== undefined) {
      rmSync(snapshotDir, { recursive: true, force: true });
      snapshotDir = undefined;
    }
  });

  runTransportConformance("live", () => {
    if (url === undefined) throw new Error("live relay not started");
    const liveUrl = url;
    const t1 = new HocuspocusTransport({ url: liveUrl, token: LIVE_TOKEN });
    const t2 = new HocuspocusTransport({ url: liveUrl, token: LIVE_TOKEN });
    // The transport opens its shared socket LAZILY on the first attach (so a boot-IDLE
    // daemon never floats a token-less, relay-rejected connection). This whole-socket
    // offline/online lever, however, drives the socket DIRECTLY — `goOffline` before the
    // first attach must find an OPEN socket to disconnect — so prime the one-shot initial
    // connect here, reproducing the steady state right after a daemon's first attach.
    void socketOf(t1).connect();
    void socketOf(t2).connect();
    return {
      provider: new YjsCrdtProvider(),
      t1,
      t2,
      goOffline: () => {
        socketOf(t2).disconnect();
      },
      goOnline: () => {
        void socketOf(t2).connect();
      },
      cleanup: async () => {
        // Disconnect BEFORE close so each shared socket's auto-reconnect timer is cancelled — a
        // socket torn down mid-reconnect could otherwise dial the relay again after this suite's
        // afterAll has shut it down (a leaked handle + a spurious post-teardown store attempt).
        socketOf(t1).disconnect();
        socketOf(t2).disconnect();
        await t1.close();
        await t2.close();
      },
    };
  });
});

/**
 * HocuspocusTransport: the live convergence suite above runs the FULL shared contract against the
 * real relay. This no-socket smoke block additionally pins the offline-construction behavior: the
 * adapter constructs WITHOUT opening a socket (`connect: false`), reports a valid `ConnStatus`,
 * tears down cleanly, and `attach` is idempotent (no leaked providers).
 */
describe("HocuspocusTransport [no-socket smoke]", () => {
  let transport: HocuspocusTransport | undefined;

  afterEach(async () => {
    await transport?.close();
    transport = undefined;
  });

  const VALID_STATUS = new Set(["connected", "connecting", "offline", "unauthorized"]);

  it("constructs without opening a socket, reports a valid status, and closes cleanly", async () => {
    transport = new HocuspocusTransport({ url: "ws://127.0.0.1:0", connect: false });
    expect(VALID_STATUS.has(transport.status())).toBe(true);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it("attach is idempotent: double-attach returns the same synced promise (no second provider)", () => {
    transport = new HocuspocusTransport({ url: "ws://127.0.0.1:0", connect: false });
    const provider = new YjsCrdtProvider();
    const docA = provider.createDoc(id("doc-idem"));

    const h1 = transport.attach(docA);
    const h2 = transport.attach(docA); // second call — must NOT create a second HocuspocusProvider

    // Both handles must return the SAME promise object (referential equality) — guarantees
    // a single underlying provider and no orphaned Y.Doc binding.
    const p = h1.synced();
    expect(h2.synced()).toBe(p);

    // Suppress the pending-then-rejected promise (detach/close will reject it with ClosedError
    // since we are offline and the transport never connected — this is expected and handled).
    void p.catch(() => undefined);

    // detach via one handle; the afterEach close() will clean up the provider.
    h2.detach();
    docA.destroy();
  });
});
