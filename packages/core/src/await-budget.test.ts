import { describe, it, expect } from "vitest";
import { awaitWithinBudget } from "./await-budget.js";

describe("awaitWithinBudget", () => {
  it("returns true when the promise resolves within budget", async () => {
    expect(await awaitWithinBudget(Promise.resolve(), 1000)).toBe(true);
  });

  it("returns false when the budget elapses before the promise settles", async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    expect(await awaitWithinBudget(new Promise<void>(() => {}), 20)).toBe(false);
  });

  it("propagates a rejection that lands within budget (does NOT swallow it)", async () => {
    await expect(awaitWithinBudget(Promise.reject(new Error("boom")), 1000)).rejects.toThrow(
      "boom",
    );
  });

  it("resolves promptly when the promise wins (timer cleared, no lingering budget wait)", async () => {
    const t0 = Date.now();
    await awaitWithinBudget(Promise.resolve(), 5000);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
