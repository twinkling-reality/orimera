/**
 * @orimera/atlas-three
 *
 * The three.js r185 + Spark 2.1.0 renderer binding: ADR-0003 option A, built so the bake-off can
 * measure it rather than argue about it.
 *
 * This is a CANDIDATE implementation of the `atlas-react` contract, not a replacement for it.
 * `atlas-react`'s own barrel records that "two competing implementations of this package are the
 * bake-off", so the engine-specific half lives here, under its engine's name, and the ADR can be
 * settled by deleting a package rather than by unpicking one.
 *
 * WHAT IS ENGINE-SPECIFIC AND THEREFORE HERE:
 *   the WebGL renderer, the point material, the .opm to GPU-buffer path, the camera rig, the
 *   pointer-lock look controller, the occupancy grid, the DOM anchor overlay, presence markers.
 *
 * WHAT IS NOT, AND THEREFORE IS NOT HERE:
 *   the scene graph, island frames, focus resolution, view manifest application, tiers and the
 *   layout solver. All of that is atlas-core and this package only calls it. Nothing in this
 *   package reimplements a decision atlas-core already made, which is what makes "switching
 *   engines is a two-package rewrite" true rather than aspirational.
 *
 * VERIFIED PLATFORM FACTS THIS BINDING IS SHAPED BY, not preferences:
 *   Pointer Lock freezes clientX/clientY, so all world targeting is reticle-based at screen
 *   centre and there is no hover path anywhere in this package.
 *   Pointer Lock is unsupported on iOS Safari and Android Chrome, so this package is the desktop
 *   Atlas and the World Index is the mobile and accessibility route. Nothing here degrades to a
 *   touch joystick.
 */

export type { RendererCapabilities, GraphicsPath } from './capabilities.js';
export { probeCapabilities } from './capabilities.js';

export type { OpmHeader, OpmSegment, PointMapData, FetchTimings } from './opm.js';
export { OPM_MAGIC, OPM_VERSION, decodeOpm, fetchPointMap } from './opm.js';

export type { SegmentBinding, SegmentStateOptions } from './semantic-state.js';
export {
  PROVENANCE_CODE,
  SEGMENT_FLAG,
  SEGMENT_TABLE_WIDTH,
  SegmentStateTable,
  bindSegmentsByName,
  unconfirmedWeight,
} from './semantic-state.js';

export type { GroundSample, OccupancyGrid } from './containment.js';
export {
  CONTAINMENT_CONSTANTS,
  GRID_RESOLUTION,
  atlasGroundToIslandGrid,
  buildOccupancyGrid,
  sampleGround,
} from './containment.js';

export type {
  PointAppearanceSettings,
  PointFrameUniforms,
  PointMaterialParams,
} from './render/point-material.js';
export { DEFAULT_APPEARANCE, PointMaterial } from './render/point-material.js';
export { POINT_FRAGMENT_SHADER, POINT_VERTEX_SHADER } from './render/point-shader.js';

export type { IslandViewOptions } from './render/island-view.js';
export { IslandView } from './render/island-view.js';

export type { PresenceContentResolver, PresenceMarkerContent } from './render/presence-markers.js';
export { PresenceMarkers } from './render/presence-markers.js';

export type { InputMode, LookSettings, TurnMode } from './controls/pointer-look.js';
export { DEFAULT_LOOK, PointerLook } from './controls/pointer-look.js';

export type { IslandGround, WalkSettings, WalkerFrame } from './controls/walker.js';
export { DEFAULT_WALK, Walker } from './controls/walker.js';

export type { NameResolver, OverlayFrameInput, ResolvedName } from './overlay/anchor-overlay.js';
export { AnchorOverlay } from './overlay/anchor-overlay.js';

export type { FrameSample, HeapReading, WindowStats } from './instrumentation.js';
export { FrameMeter, readHeap } from './instrumentation.js';

export type {
  AtlasFrameReport,
  AtlasRendererOptions,
  ComfortSettings,
} from './atlas-renderer.js';
export { AtlasRenderer, DEFAULT_COMFORT } from './atlas-renderer.js';

export type { SparkIslandHandle, SparkIslandOptions } from './spark-island.js';
export { addSparkIsland } from './spark-island.js';

export { ATLAS_OVERLAY_CSS } from './overlay/overlay-css.js';
