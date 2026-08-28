/**
 * @orimera/atlas-core
 *
 * The scene graph, island frames, focus resolution, view manifest application and the layout
 * solver. Pure TypeScript: no React, no DOM, no renderer.
 *
 * The DOM ban is enforced by `lib: ["ES2022"]` in this package's tsconfig rather than by lint,
 * because `document` is a global and not an import. The React and renderer bans are enforced by
 * `.dependency-cruiser.cjs`.
 *
 * NOTE ON WHAT IS NOT EXPORTED HERE. There is no distance function over `AtlasVec3` in this
 * barrel, and no `atlasToLocal`. An island's atlas position is a layout artifact and reading it
 * as geometry is risk R-48. The layout and focus solvers need atlas-space distance and get it
 * from `@orimera/atlas-core/presentation-metrics`, which the query layer may not import.
 */

export type { Brand } from './brand.js';

export type {
  AnchorId,
  EntityId,
  EvidenceRef,
  IslandId,
  ManifestId,
  OccurrenceId,
  SegmentId,
} from './ids.js';
export {
  anchorId,
  entityId,
  evidenceRef,
  islandId,
  manifestId,
  occurrenceId,
  segmentId,
} from './ids.js';

export type { AnyVec3, AtlasVec3, IslandPlacement, LocalVec3, MetricVec3 } from './coords.js';
export {
  ATLAS_ORIGIN,
  CAPTURE_FORWARD_LOCAL,
  LOCAL_ORIGIN,
  add,
  atlasVec3,
  dot,
  lengthOf,
  localDirectionToAtlas,
  localDistance,
  localToAtlas,
  localVec3,
  metricAsLocal,
  metricDistance,
  metricVec3,
  normalize,
  placement,
  scale,
  sub,
} from './coords.js';

export type { MovementModel, ReconstructionRung, RungProperties } from './rung.js';
export { SINGLE_PHOTO_RUNG, rungProperties } from './rung.js';

export type { ConfidenceBand, LinkState, ProvenanceClass } from './provenance.js';
export { contributesToLayout, isConfirmed, readsAsUnconfirmed } from './provenance.js';

export type { Anchor, AnchorKind } from './anchor.js';
export { rendersAsPresenceMarker } from './anchor.js';

export type { Island } from './island.js';
export {
  DISSOLVE_BAND_FRACTION,
  asMetricLocal,
  dissolveBandParameter,
  islandRung,
  makeIsland,
} from './island.js';

export type { AnchorTable, AtlasScene } from './scene.js';
export { anchorAtlasPosition, buildAnchorTable, makeScene } from './scene.js';

export type { EmphasisLevel } from './emphasis.js';
export { EMPHASIS_SCALAR, emphasisImportance, isInteractable, isLabelable } from './emphasis.js';

export type { RepresentationTier, TierState } from './tiers.js';
export {
  EMPTY_TIER_STATE,
  MAX_TIER_3_ISLANDS,
  TIER_DEMOTE_FACTOR,
  TIER_PROMOTE_AU,
  resolveTiers,
} from './tiers.js';

export type {
  ManifestCaption,
  ManifestEmphasis,
  ManifestQuery,
  ManifestSummary,
  ManifestThread,
  ManifestTransition,
  QueryKind,
  SummaryCount,
  ThreadStyle,
  ViewManifest,
} from './manifest/types.js';
export { MAX_CAPTIONS, MAX_EDGE_CHEVRONS, MAX_FOCUS_LABELS } from './manifest/types.js';

export type { EmphasisBuffers, EmphasisFrame } from './manifest/apply.js';
export {
  LEVEL_ORDER,
  ManifestValidationError,
  allocateEmphasisBuffers,
  applyViewManifest,
  applyViewManifestInto,
  levelAt,
  neutralEmphasis,
  validateManifest,
} from './manifest/apply.js';

export type {
  ConjunctionQueryResult,
  DisjunctionQueryResult,
  EntityQueryResult,
  ManifestIdentity,
  ProposalPreview,
} from './manifest/build.js';
export {
  buildConjunctionManifest,
  buildDisjunctionManifest,
  buildEntityManifest,
  buildPreviewManifest,
} from './manifest/build.js';

export type { ManifestState } from './manifest/stack.js';
export {
  EMPTY_MANIFEST_STATE,
  clearPreview,
  clearStack,
  pinManifest,
  popManifest,
  pushManifest,
  resolveActive,
  setPreview,
  staleManifests,
} from './manifest/stack.js';

export type {
  CameraPose,
  FocusCandidate,
  FocusConfig,
  FocusInputs,
  FocusResolution,
  FocusState,
  VisibilityTest,
} from './focus/solver.js';
export {
  DEFAULT_FOCUS_CONFIG,
  INITIAL_FOCUS_STATE,
  focusDirectly,
  forwardFromYawPitch,
  latchFocus,
  releaseFocus,
  resolveFocus,
  tabOrder,
} from './focus/solver.js';
export { IMPORTANCE_WEIGHTS, deriveImportance, occurrenceNormalizer } from './focus/importance.js';

export type {
  LayoutConfig,
  LayoutInputIsland,
  LayoutMove,
  LayoutResult,
  LayoutStrategy,
} from './layout/solver.js';
export {
  DEFAULT_LAYOUT_CONFIG,
  LAYOUT_GLIDE_MS,
  LayoutScopeError,
  MAX_ISLANDS,
  solveLayout,
} from './layout/solver.js';
export { GOLDEN_ANGLE, phyllotaxisSeed } from './layout/phyllotaxis.js';
export type { SeedPoint } from './layout/phyllotaxis.js';
export {
  layoutEntitiesOf,
  semanticSimilarity,
  sharedLayoutEntityCount,
} from './layout/similarity.js';
