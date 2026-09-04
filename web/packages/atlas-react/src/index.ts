/**
 * @exulanica/atlas-react
 *
 * Renderer bindings, the anchor overlay, the HUD and comfort settings. Forbidden: graph
 * mutations (architecture-overview.md 1.1), enforced as a path ban on
 * `@exulanica/graph-client/mutations` in `.dependency-cruiser.cjs`.
 *
 * Named for a renderer BINDING layer, not for a specific engine. Which engine sits under it is
 * ADR-0003, resolved on 2026-08-28 in favour of PlayCanvas Engine 2.21.4 by matched-resolution
 * measurement. Everything engine-specific belongs in this package, because the module contract is
 * what turns a renderer switch from a front-end rewrite into a two-package rewrite.
 *
 * The three.js binding in `@exulanica/atlas-three` is deliberately retained rather than deleted:
 * the ADR records that keeping a second implementation is what proves the boundary holds.
 */

export const ATLAS_REACT_PACKAGE = '@exulanica/atlas-react';
