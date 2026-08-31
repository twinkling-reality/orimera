import { defineConfig, type Plugin } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewApiResponse } from './src/dev/preview-api.js';

const APP_ROOT = fileURLToPath(new URL('.', import.meta.url));

const previewApi: Plugin = {
  name: 'orimera-atlas-preview-api',
  configureServer(server) {
    server.middlewares.use('/preview-api', async (request, response) => {
      const decision = previewApiResponse(request.method ?? 'GET', request.url ?? '/');
      response.setHeader('cache-control', 'no-store');
      response.statusCode = decision.statusCode;
      if (decision.assetPath !== undefined) {
        response.setHeader('content-type', decision.contentType ?? 'application/octet-stream');
        response.end(await readFile(resolve(APP_ROOT, 'public', decision.assetPath)));
        return;
      }
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(decision.body));
    });
  },
};

/**
 * The authenticated surface.
 *
 * The API is reached through a dev proxy rather than by naming its origin in the client, so the
 * browser makes same-origin requests and no CORS policy has to exist for development that would
 * not exist in production. `ORIMERA_API_URL` moves it; the default is the port the deployment
 * guide's uvicorn command uses.
 */
export default defineConfig({
  build: { target: 'es2022' },
  plugins: [previewApi],
  server: {
    proxy: {
      '/api': {
        target: process.env['ORIMERA_API_URL'] ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
