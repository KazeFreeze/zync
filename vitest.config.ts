import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "packages/harness/**"],
    // Safety net: cap each worker's heap and bound per-test time so a runaway
    // convergence/relay loop fails FAST (heap-OOM or timeout in the worker)
    // instead of exhausting system RAM+swap and OOM-killing the box.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--max-old-space-size=1024"] } },
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
