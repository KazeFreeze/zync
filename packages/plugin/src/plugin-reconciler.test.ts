import { describe, it, expect } from "vitest";
import { PluginReconciler, type ReconcilerDeps } from "./plugin-reconciler.js";

// A controllable fake: `running` is a live set; enable/disable mutate it after an awaitable tick.
function harness(opts: { desired: Set<string>; running?: Set<string>; managed?: Set<string> }) {
  const running = opts.running ?? new Set<string>();
  const managed = opts.managed ?? new Set<string>([...opts.desired, ...running]);
  const deps: ReconcilerDeps = {
    desired: () => new Set(opts.desired),
    running: () => new Set(running),
    isManaged: (id) => managed.has(id),
    enable: async (id) => {
      await Promise.resolve();
      running.add(id);
    },
    disable: async (id) => {
      await Promise.resolve();
      running.delete(id);
    },
  };
  return { deps, running, desired: opts.desired };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("PluginReconciler", () => {
  it("enables a desired-but-not-running plugin", async () => {
    const h = harness({ desired: new Set(["a"]) });
    const r = new PluginReconciler(h.deps);
    r.reconcile();
    await flush();
    expect(h.running.has("a")).toBe(true);
  });

  it("disables a running-but-not-desired MANAGED plugin", async () => {
    const h = harness({ desired: new Set(), running: new Set(["a"]), managed: new Set(["a"]) });
    const r = new PluginReconciler(h.deps);
    r.reconcile();
    await flush();
    expect(h.running.has("a")).toBe(false);
  });

  it("never touches a running plugin Zync does not manage", async () => {
    const h = harness({ desired: new Set(), running: new Set(["a"]), managed: new Set() });
    const r = new PluginReconciler(h.deps);
    r.reconcile();
    await flush();
    expect(h.running.has("a")).toBe(true);
  });

  it("self-corrects a suppress that lands mid-enable (the H2 race)", async () => {
    const desired = new Set(["a"]);
    const h = harness({ desired });
    const r = new PluginReconciler(h.deps);
    r.reconcile(); // enqueue enable(a)
    desired.delete("a"); // desired flips to OFF while enable is in flight
    await flush();
    expect(h.running.has("a")).toBe(false); // converged to the latest desired
  });
});
