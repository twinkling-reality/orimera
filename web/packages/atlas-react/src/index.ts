/**
 * @orimera/atlas-react
 *
 * Renderer bindings, the anchor overlay, the HUD and comfort settings. Forbidden: graph
 * mutations (architecture-overview.md 1.1), enforced as a path ban on
 * `@orimera/graph-client/mutations` in `.dependency-cruiser.cjs`.
 *
 * Named for a renderer BINDING layer, not for a specific engine. Which engine sits under it is
 * ADR-0003, which is unresolved and settles at the bake-off. Everything engine-specific belongs
 * in this package, because the module contract is what turns a renderer switch from a front-end
 * rewrite into a two-package rewrite.
 *
 * STATUS: two competing implementations of this package are the bake-off. This file fixes the
 * package identity and the boundary.
 */

export const ATLAS_REACT_PACKAGE = '@orimera/atlas-react';
