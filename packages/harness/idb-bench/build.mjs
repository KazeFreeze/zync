/**
 * Bundle the portable bench entry (src/entry.ts -> public/bundle.js) with esbuild,
 * inlining yjs + y-indexeddb + idb for the browser. Run before the Playwright runner.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(__dirname, "src/entry.ts")],
  outfile: join(__dirname, "public/bundle.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log("[build] wrote public/bundle.js");
