import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/main.js",
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "packages/plugin/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["obsidian", "yjs", "y-*", "@hocuspocus/*", "@codemirror/*", "node:*"],
              message: "core is pure domain + ports — depend on a port.",
            },
          ],
        },
      ],
    },
  },
);
