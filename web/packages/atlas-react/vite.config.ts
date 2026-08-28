import { defineConfig } from 'vite';

/**
 * Dev server and build for the ADR-0003 bake-off page.
 *
 * THE ALIAS IS NOT COSMETIC AND IT IS EASY TO GET WRONG. The `playcanvas` package declares a
 * `development` export condition that resolves to `build/playcanvas.dbg`, and Vite's dev server
 * applies that condition by default. The debug build carries every `Debug.assert`, every trace
 * hook and none of the dead-code elimination, and it is materially slower. A bake-off measured
 * against it is measuring the wrong engine. The alias pins the release ESM build in BOTH dev and
 * production so the number the dev server prints is the number the build would print.
 *
 * If you want the asserts back while developing the binding, point the alias at
 * `playcanvas/build/playcanvas.dbg/src/index.js` and do not report the numbers.
 *
 * `publicDir` points at the workspace fixtures directory, so `harbour-1M.opm` is served from the
 * origin root with no copy step. Fixtures are gitignored and regenerated with
 * `pnpm synth --out ./fixtures`, so a copy would go stale silently.
 */
export default defineConfig({
  publicDir: '../../fixtures',
  server: { port: 5183, strictPort: true },
  resolve: {
    alias: { playcanvas: 'playcanvas/build/playcanvas/src/index.js' },
  },
  optimizeDeps: { exclude: ['playcanvas'] },
  build: {
    target: 'es2022',
    minify: 'esbuild',
    rollupOptions: { input: 'playcanvas-bakeoff.html' },
  },
});
