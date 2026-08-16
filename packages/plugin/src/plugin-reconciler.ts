/**
 * Pure, serialized plugin reconciler — the unit-testable core behind the live-apply reconcile.
 * Diffs desired-active vs running and drives each plugin toward the desired state, but:
 *  - serialized PER PLUGIN (a promise chain per id) so no two enable/disable ops for the same
 *    plugin ever run concurrently;
 *  - re-reads the LATEST desired/running after each apply (loop), so a change that landed while an
 *    earlier op was in flight self-corrects (fixes H2: a suppress lost mid-enable);
 *  - never touches a running plugin Zync does not manage;
 *  - reports when live apply fails or exhausts without converging — silent "success" after five
 *    false-ok rounds was worse than an error (the UI claimed the plugin flipped when it had not).
 * No DOM/Obsidian — deps are injected.
 */
export interface ReconcilerDeps {
  desired: () => Set<string>;
  running: () => Set<string>;
  isManaged: (id: string) => boolean;
  enable: (id: string) => Promise<void>;
  disable: (id: string) => Promise<void>;
  /**
   * Fired when live apply did not converge (throw, or still diverged after max rounds).
   * `wantEnabled` is the desired running state at the moment of failure.
   */
  onApplyFailed?: (id: string, wantEnabled: boolean, err: unknown) => void;
}

export const RECONCILE_MAX_ROUNDS = 5;

export class PluginReconciler {
  private readonly chains = new Map<string, Promise<void>>();
  constructor(private readonly d: ReconcilerDeps) {}

  /** Enqueue convergence for every plugin whose live state differs from desired. */
  reconcile(): void {
    const ids = new Set<string>([...this.d.desired(), ...this.d.running()]);
    for (const id of ids) this.drive(id);
  }

  private drive(id: string): void {
    const prev = this.chains.get(id) ?? Promise.resolve();
    // Do NOT swallow: a rejected enable used to vanish here, so five "successful" no-ops looked
    // like convergence and the user was told nothing. Report, then settle the chain so a later
    // reconcile can retry.
    const next = prev
      .then(() => this.converge(id))
      .catch((err) => {
        const wantEnabled = this.d.desired().has(id);
        this.d.onApplyFailed?.(id, wantEnabled, err);
      });
    this.chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  private async converge(id: string): Promise<void> {
    for (let round = 0; round < RECONCILE_MAX_ROUNDS; round++) {
      const want = this.d.desired().has(id);
      const on = this.d.running().has(id);
      if (want === on) return;
      if (!want && !this.d.isManaged(id)) return; // never disable a plugin Zync doesn't manage
      if (want) await this.d.enable(id);
      else await this.d.disable(id);
    }
    // Still diverged after max rounds — enable/disable claimed success but the running set did
    // not move (the false-success path). Surface it; do not exit silently.
    const want = this.d.desired().has(id);
    if (want !== this.d.running().has(id)) {
      this.d.onApplyFailed?.(
        id,
        want,
        new Error(
          `plugin ${id} still ${want ? "inactive" : "active"} after ${String(RECONCILE_MAX_ROUNDS)} apply rounds`,
        ),
      );
    }
  }
}
