/**
 * Await `p` but give up after `budgetMs`. Returns `true` if `p` RESOLVES within the budget,
 * `false` if the budget elapses first. A rejection within the budget is RE-THROWN (not
 * swallowed) — callers rely on that to propagate a real teardown/`ClosedError` rather than
 * mistaking it for "timed out". The timeout timer is always cleared (via `finally`), so a
 * fast-resolving promise never leaves a dangling timer holding the event loop open.
 */
export async function awaitWithinBudget(p: Promise<unknown>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, budgetMs);
  });
  try {
    // p resolves -> true; p rejects -> this arm rejects and Promise.race propagates it;
    // budget elapses first -> false.
    return await Promise.race([p.then(() => true as const), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
