import { defineConfig } from 'vite';

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
