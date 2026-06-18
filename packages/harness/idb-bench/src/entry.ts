/**
 * Browser entry — bundled by esbuild into `public/bundle.js` and loaded by
 * `public/index.html`. Exposes the portable bench API on `window.zyncBench` so the
 * Playwright runner can invoke each phase via `page.evaluate`.
 */
import { bench } from "./bench";

declare global {
  interface Window {
    zyncBench: typeof bench;
  }
}

window.zyncBench = bench;
