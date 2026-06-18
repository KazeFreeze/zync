import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const banner = `/*
 * Zync — bundled Obsidian plugin (CommonJS). Generated; do not edit directly.
 * Source: packages/plugin/src — build with: pnpm --filter @zync/plugin build
 */`;

const prod = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian + the CodeMirror packages it bundles MUST stay external so the
  // plugin binds to the app's single CM6 instance — a second bundled copy
  // corrupts editor state (the y-codemirror.next binding reaches CM this way).
  // Node builtins are external too (the plugin runs in Obsidian's runtime).
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
