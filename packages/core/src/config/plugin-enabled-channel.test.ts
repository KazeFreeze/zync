import { describe, it, expect, vi } from "vitest";
import { FakeCrdtMap } from "../testing/fake-crdt-map.js";
import { PluginEnabledChannel, type CommunityPluginsPort } from "./plugin-enabled-channel.js";
import type { PluginMeta } from "./plugin-maps.js";

function fakePort(initial: string[] | null) {
  let arr = initial;
  const cbs = new Set<() => void>();
  const port: CommunityPluginsPort & {
    external: (a: string[]) => void;
    current: () => string[] | null;
  } = {
    read: () => Promise.resolve(arr),
    writeAtomic: (ids) => {
      arr = [...ids];
      return Promise.resolve();
    },
    onChange: (cb) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    close: () => undefined,
    external: (a) => {
      arr = [...a];
      cbs.forEach((c) => {
        c();
      });
    },
    current: () => arr,
  };
  return port;
}
type FakePort = CommunityPluginsPort & {
  external: (a: string[]) => void;
  current: () => string[] | null;
};

/**
 * Like {@link fakePort}, but `writeAtomic` ALSO fires the `onChange` callbacks —
 * simulating a real filesystem watcher that observes our OWN projection write.
 * This is what actually exercises the echo guard (`fakePort` never fires onChange
 * on write, so with it the guard is never reached).
 */
function echoingFakePort(initial: string[] | null): FakePort {
  let arr = initial;
  const cbs = new Set<() => void>();
  const fire = () => {
    cbs.forEach((c) => {
      c();
    });
  };
  return {
    read: () => Promise.resolve(arr),
    writeAtomic: (ids) => {
      arr = [...ids];
      fire(); // watcher sees our own write -> onChange -> ingest (must be echo-dropped)
      return Promise.resolve();
    },
    onChange: (cb) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    close: () => undefined,
    external: (a) => {
      arr = [...a];
      fire();
    },
    current: () => arr,
  };
}

const poll = async (fn: () => void, ms = 500) => {
  const t = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (e) {
      if (Date.now() - t > ms) throw e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
};

function make(initialArray: string[] | null, opts?: { isMobile?: boolean; port?: FakePort }) {
  const optIn = new FakeCrdtMap<boolean>();
  const enabled = new FakeCrdtMap<boolean>();
  const meta = new FakeCrdtMap<PluginMeta>();
  const suppress = new Set<string>();
  const port = opts?.port ?? fakePort(initialArray);
  const ch = new PluginEnabledChannel({
    optIn,
    enabled,
    meta,
    port,
    isMobile: opts?.isMobile ?? false,
    suppress: () => suppress,
  });
  return { optIn, enabled, meta, suppress, port, ch };
}

describe("PluginEnabledChannel", () => {
  it("outbound: enabling an opted-in plugin projects it into community-plugins.json, preserving local-only", async () => {
    const { optIn, enabled, port, ch } = make(["localonly"]);
    ch.start();
    optIn.set("dv", true);
    enabled.set("dv", true);
    await poll(() => {
      expect(port.current()?.sort()).toEqual(["dv", "localonly"]);
    });
  });

  it("outbound: disabling removes it but keeps local-only", async () => {
    const { optIn, enabled, port, ch } = make(["dv", "localonly"]);
    optIn.set("dv", true);
    enabled.set("dv", true);
    ch.start();
    enabled.set("dv", false);
    await poll(() => {
      expect(port.current()?.sort()).toEqual(["localonly"]);
    });
  });

  it("inbound: an EXTERNAL native toggle of a managed plugin ingests into pluginsEnabled", async () => {
    const { optIn, enabled, port, ch } = make([]);
    optIn.set("dv", true);
    ch.start();
    port.external(["dv"]); // user enabled dv via Obsidian's native UI
    await poll(() => {
      expect(enabled.get("dv")).toBe(true);
    });
  });

  it("inbound ignores NON-managed ids (a suppressed plugin absent from the array does NOT set shared disable)", async () => {
    const { optIn, enabled, suppress, port, ch } = make([]);
    optIn.set("dv", true);
    enabled.set("dv", true);
    suppress.add("dv"); // suppressed here
    ch.start();
    port.external([]); // dv absent locally because suppressed
    await new Promise((r) => setTimeout(r, 60));
    expect(enabled.get("dv")).toBe(true); // NOT flipped to false — no shared-disable leak
  });

  it("echo guard: the channel's OWN projection write does not re-ingest", async () => {
    const { optIn, enabled, port, ch } = make([]);
    const ingestSpy = vi.spyOn(port, "writeAtomic");
    optIn.set("dv", true);
    ch.start();
    enabled.set("dv", true); // triggers a projection write -> onChange fires
    await poll(() => {
      expect(port.current()).toEqual(["dv"]);
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(enabled.get("dv")).toBe(true); // unchanged; the echo did not flip it
    ingestSpy.mockRestore();
  });

  it("reproject(): a suppress change re-runs the projection (removing the suppressed id)", async () => {
    const { optIn, enabled, suppress, port, ch } = make([]);
    optIn.set("dv", true);
    enabled.set("dv", true);
    ch.start();
    await poll(() => {
      expect(port.current()).toEqual(["dv"]);
    });
    suppress.add("dv");
    ch.reproject();
    await poll(() => {
      expect(port.current()).toEqual([]);
    });
    // D6 no-leak: suppressing/removing locally must NOT flip the SHARED enabled bit.
    expect(enabled.get("dv")).toBe(true);
  });

  it("echo guard (watcher fires on our OWN write): the projected array is not re-ingested", async () => {
    // echoingFakePort fires onChange on writeAtomic (a real watcher seeing our own write), so the
    // ingest path actually RUNS here. (The plain fakePort never fires onChange, so with it ingest
    // never executes and the guard line is never reached — the gap this test closes.) The
    // arraysEqual(arr, lastProjected) guard drops the echo, so the ingest read does NOT re-derive or
    // spuriously flip the shared bit, and the array stays exactly what we projected.
    const port = echoingFakePort([]);
    const { optIn, enabled, ch } = make(null, { port });
    optIn.set("dv", true);
    ch.start();
    enabled.set("dv", true); // -> project writes ["dv"] -> writeAtomic fires onChange (echo -> ingest)
    await poll(() => {
      expect(port.current()).toEqual(["dv"]);
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(enabled.get("dv")).toBe(true); // echo dropped: the bit was not re-derived/flipped
    expect(port.current()).toEqual(["dv"]); // array stable (no echo-driven rewrite churn)
  });

  it("inbound: a null read (absent/corrupt community-plugins.json) does NOT flip managed enabled bits to false", async () => {
    // A managed+enabled id, then a watcher fire where read() returns null (file gone or corrupt).
    // ingest MUST skip — a null read is not an authoritative "disable everything" — so the shared
    // enabled bit stays true (coercing null to [] here would replicate a shared-disable to all peers).
    let arr: string[] | null = ["dv"];
    const cbs = new Set<() => void>();
    const port: CommunityPluginsPort = {
      read: () => Promise.resolve(arr),
      writeAtomic: (ids) => {
        arr = [...ids];
        return Promise.resolve();
      },
      onChange: (cb) => {
        cbs.add(cb);
        return () => cbs.delete(cb);
      },
      close: () => undefined,
    };
    const optIn = new FakeCrdtMap<boolean>();
    const enabled = new FakeCrdtMap<boolean>();
    const meta = new FakeCrdtMap<PluginMeta>();
    const suppress = new Set<string>();
    optIn.set("dv", true);
    enabled.set("dv", true);
    const ch = new PluginEnabledChannel({
      optIn,
      enabled,
      meta,
      port,
      isMobile: false,
      suppress: () => suppress,
    });
    ch.start();
    arr = null; // file becomes absent / unreadable / torn
    cbs.forEach((c) => {
      c(); // watcher fires -> ingest reads null -> must skip
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(enabled.get("dv")).toBe(true); // NOT flipped to false — null read skipped ingest
  });

  it("defensive ingest reproject: re-adding a SUPPRESSED id is re-removed without flipping the bit", async () => {
    // A net-zero managed delta (suppressed ids are excluded from ingest managed()), so no
    // enabled.observe re-projects. The defensive reproject in ingest() re-asserts owned state.
    const port = echoingFakePort([]);
    const { optIn, enabled, suppress, ch } = make(null, { port });
    optIn.set("dv", true);
    enabled.set("dv", true);
    suppress.add("dv"); // suppressed: projection keeps it OUT of this device's array
    ch.start();
    await poll(() => {
      expect(port.current()).toEqual([]);
    });
    port.external(["dv"]); // someone re-adds the suppressed id to community-plugins.json
    await poll(() => {
      expect(port.current()).toEqual([]); // channel re-removes it (defensive reproject)
    });
    expect(enabled.get("dv")).toBe(true); // shared bit unchanged (no leak)
  });
});
