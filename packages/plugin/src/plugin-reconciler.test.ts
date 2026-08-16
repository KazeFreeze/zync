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

  /**
   * enable that resolves without flipping `running` used to look like success for five rounds,
   * then exit silently — the UI claimed the plugin was on when it was not.
   */
  it("reports when enable claims success but the plugin stays inactive", async () => {
    const failures: { id: string; want: boolean }[] = [];
    const deps: ReconcilerDeps = {
      desired: () => new Set(["a"]),
      running: () => new Set(), // never flips — the false-success path
      isManaged: () => true,
      enable: async () => undefined, // resolves, does nothing
      disable: async () => undefined,
      onApplyFailed: (id, wantEnabled) => {
        failures.push({ id, want: wantEnabled });
      },
    };
    new PluginReconciler(deps).reconcile();
    await flush();
    expect(failures).toEqual([{ id: "a", want: true }]);
  });

  it("reports when enable rejects instead of swallowing the error", async () => {
    const failures: unknown[] = [];
    const deps: ReconcilerDeps = {
      desired: () => new Set(["a"]),
      running: () => new Set(),
      isManaged: () => true,
      enable: async () => {
        throw new Error("API missing");
      },
      disable: async () => undefined,
      onApplyFailed: (_id, _want, err) => {
        failures.push(err);
      },
    };
    new PluginReconciler(deps).reconcile();
    await flush();
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/API missing/);
  });
});
