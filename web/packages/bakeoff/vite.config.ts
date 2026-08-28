import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The fixtures live outside this package and are gitignored, because a 72 MB point map does not
 * belong in a repository and `pnpm synth` regenerates the whole ladder in about ten seconds.
 * They are served as static assets from their real location rather than copied, so a bake-off
 * run measures the file the generator just wrote and there is no stale copy to be confused by.
 */
const fixtures = fileURLToPath(new URL('../../fixtures', import.meta.url));
const resultsDir = fileURLToPath(new URL('../../bakeoff-results', import.meta.url));

/**
 * THE RESULT SINK, and the reason it has to exist.
 *
 * ADR-0003 X-R1 requires the run to happen "in visible Chrome with the window in the foreground,
 * because a hidden render pane throttles requestAnimationFrame and invalidates the numbers". A
 * foreground window is exactly the window whose console an automated driver cannot read. So the
 * page posts its own summary back here and the server writes it to a file, which makes the run
 * both foreground AND automatable instead of one or the other.
 *
 * Dev-server only, local only, and it writes nothing but the JSON body it was handed.
 */
function resultSink(): Plugin {
  return {
    name: 'orimera-bakeoff-result-sink',
    configureServer(server) {
      server.middlewares.use('/__bakeoff/result', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          mkdirSync(resultsDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = join(resultsDir, `bakeoff-${stamp}.json`);
          writeFileSync(file, body);
          // Also to a stable name, so a driver does not have to guess the timestamp.
          writeFileSync(join(resultsDir, 'latest.json'), body);
          server.config.logger.info(`bakeoff result written: ${file}`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  publicDir: fixtures,
  plugins: [resultSink()],
  server: {
    // The harness prints its own numbers; a live-reload round trip in the middle of a
    // measurement window would corrupt one, so HMR is off for the measured page.
    hmr: false,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
  build: { target: 'es2022' },
});
