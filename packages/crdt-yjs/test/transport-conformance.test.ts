import { describe, it, expect, afterEach } from "vitest";
import type { CrdtProvider, DocId, TextEdit, TransportPort } from "@zync/core";
import { ClosedError, InProcessBus, InProcessTransport } from "@zync/core/testing";
import { YjsCrdtProvider } from "../src/index.js";
import { HocuspocusTransport } from "../src/transport-hocuspocus.js";

const id = (s: string): DocId => s as DocId;
const ins = (at: number, insert: string): TextEdit => ({ at, delete: 0, insert });

/**
 * Two linked transports off one substrate, plus a `CrdtProvider` to mint docs. The InProcessBus
 * harness also exposes the concrete {@link InProcessTransport}s so a test can drive
 * `goOffline`/`goOnline`/`partition`/`heal` — capabilities the abstract {@link TransportPort}
 * does not (and should not) carry.
 */
interface ConformanceHarness {
  readonly provider: CrdtProvider;
  readonly t1: InProcessTransport;
  readonly t2: InProcessTransport;
  cleanup(): Promise<void>;
}

/**
 * Provider-parameterized transport-conformance suite. Written against the `@zync/core`
 * ports + the InProcessTransport test controls only — no Yjs internals — so the SAME contract
 * checks can later run against any {@link TransportPort} (a Loro substrate, the live Hocuspocus
 * relay in 0b-3, etc.).
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

      const docA = provider.createDoc(id("doc"));
      const docB = provider.createDoc(id("doc"));
      const a = t1.attach(docA);
      const b = t2.attach(docB);
      await Promise.all([a.synced(), b.synced()]);

      docA.applyEdits([ins(0, "hello")], "local-editor");
      expect(docB.getText()).toBe("hello");

      docB.applyEdits([ins(5, " world")], "local-editor");
      expect(docA.getText()).toBe("hello world");
      expect(docB.getText()).toBe("hello world");

      a.detach();
      b.detach();
      docA.destroy();
      docB.destroy();
    });

    it("offline-attach: synced() pends, auto-resync on goOnline carries queued edits", async () => {
      harness = make();
      const { provider, t1, t2 } = harness;

      const docA = provider.createDoc(id("doc"));
      const a = t1.attach(docA);
      await a.synced();

      // Attach docB on the offline transport: attach returns immediately, synced() pends.
      t2.goOffline();
      const docB = provider.createDoc(id("doc"));
      const b = t2.attach(docB);

      let resolved = false;
      void b.synced().then(() => (resolved = true));
      await Promise.resolve(); // let any (wrong) microtask resolution surface
      expect(resolved).toBe(false);

      // Edit on A while B is offline — not delivered yet.
      docA.applyEdits([ins(0, "offline-edit")], "local-editor");
      expect(docB.getText()).toBe("");

      // Reconnect → auto-resync resolves synced() and carries A's text to B.
      t2.goOnline();
      await b.synced();
      expect(resolved).toBe(true);
      expect(docB.getText()).toBe("offline-edit");

      a.detach();
      b.detach();
      docA.destroy();
      docB.destroy();
    });

    it("partition: synced() stays resolved but edits pend; heal auto-resyncs (no re-attach)", async () => {
      harness = make();
      const { provider, t1, t2 } = harness;

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

    it("no echo: a relayed remote update does not bounce back to the sender", async () => {
      harness = make();
      const { provider, t1, t2 } = harness;

      const docA = provider.createDoc(id("doc"));
      const docB = provider.createDoc(id("doc"));
      const a = t1.attach(docA);
      const b = t2.attach(docB);
      await Promise.all([a.synced(), b.synced()]);

      // Count INBOUND relay applies on each doc. Yjs dedupes by content, so an echoed update
      // would not fire `onUpdate` — but it WOULD re-invoke `applyUpdate`. Counting applies is the
      // load-bearing signal that the loop-breaker actually suppresses the bounce-back.
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

    it("close() rejects in-flight synced() with ClosedError", async () => {
      harness = make();
      const { provider, t2 } = harness;

      t2.goOffline();
      const docB = provider.createDoc(id("doc"));
      const b = t2.attach(docB); // synced() pends — offline, never exchanged
      const pending = b.synced();

      await t2.close();
      await expect(pending).rejects.toBeInstanceOf(ClosedError);

      docB.destroy();
    });
  });
}

runTransportConformance("in-process", () => {
  const bus = new InProcessBus();
  const t1 = bus.connect();
  const t2 = bus.connect();
  return {
    provider: new YjsCrdtProvider(),
    t1,
    t2,
    cleanup: async () => {
      await t1.close();
      await t2.close();
    },
  };
});

/**
 * HocuspocusTransport: the LIVE convergence suite needs the Docker relay and is deferred to 0b-3.
 * Here we only assert the adapter constructs WITHOUT opening a socket (`connect: false`), reports a
 * valid `ConnStatus`, and tears down cleanly — leaving no open handles for vitest.
 */
describe("HocuspocusTransport [no-socket smoke]", () => {
  let transport: TransportPort | undefined;

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
});
