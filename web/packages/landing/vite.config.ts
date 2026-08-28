import { defineConfig } from 'vite';

/**
 * The signed-out landing surface.
 *
 * No renderer, by design. ADR-0003 is unresolved and this page must not depend on its outcome,
 * so nothing here imports three.js, Spark, PlayCanvas, `@orimera/atlas-three` or
 * `@orimera/atlas-react`. The atmosphere is a 2D canvas particle field, which is enough for the
 * landing composition and for the entrance transition into an unformed Atlas.
 */
export default defineConfig({
  build: { target: 'es2022' },
});
