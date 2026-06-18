import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/main.js",
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "packages/plugin/**",
      // Harness fixtures are synthetic test DATA, not typed source. The routing
      // fixture's deterministic 5 MB-blob generator is a plain Node `.mjs` script
      // run at fixture-prep time; it is not part of any tsconfig project.
      "packages/harness/fixtures/**",
      // IDB-bench orchestration scripts (esbuild builder + Playwright runner) are
      // plain Node `.mjs` glue, not part of any tsconfig project; the generated
      // browser bundle is build output. The PORTABLE bench logic in
      // `idb-bench/src/**` IS still linted (see the relaxation block below).
      "packages/harness/idb-bench/*.mjs",
      "packages/harness/idb-bench/public/**",
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["packages/server/smoke-test.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Core-purity firewall: packages/core must not import infrastructure deps
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "obsidian",
                "yjs",
                "y-*",
                "loro-crdt",
                "@hocuspocus/*",
                "@codemirror/*",
                "@aws-sdk/*",
                "node:*",
              ],
              message: "core is pure domain + ports — depend on a port.",
            },
          ],
        },
      ],
    },
  },
  // Targeted relaxation for server package — Hocuspocus/yjs types aren't fully typed;
  // server is an infrastructure adapter, not the core domain.
  {
    files: ["packages/server/**/*.ts", "packages/server/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  // IDB-bench portable src — a standalone benchmark, not shipped engine code. The
  // raw IndexedDB request API (`IDBRequest.result` is `any`) and `idb`/`yjs` interop
  // legitimately surface unsafe-typed values; relax those for the bench only.
  {
    files: ["packages/harness/idb-bench/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  // Root tool-config files (eslint.config.mjs, commitlint.config.js, vitest.config.ts)
  // are not source — relax type-aware rules that don't apply to loose JS/TS configs
  {
    files: ["*.mjs", "*.js", "*.ts"],
    ignores: ["packages/**"],
    rules: {
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
);
