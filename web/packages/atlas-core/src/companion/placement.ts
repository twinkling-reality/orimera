import type { AtlasVec3 } from '../coords.js';
import { add, atlasVec3, dot, normalize, scale, sub } from '../coords.js';
import type { CameraPose, VisibilityTest } from '../focus/solver.js';
import { atlasDistance } from '../presentation-metrics.js';

/**
 * Where the Companion stands. A solver, never a parent transform.
 *
 * interaction-model.md 4.2 specifies an arc around the subject point with six rejection rules and
 * a four-term score. It is written as a solver because the alternative, parenting the Companion to
 * the camera at a fixed offset, produces an escort: it never occludes, never stands behind the
 * thing under discussion, and moves every frame the user turns. 4.2 rules that out explicitly
 * ("the Companion never follows the user continuously").
 *
 * The consequence worth stating, because it constrains the renderer: the transform is recomputed
 * from scene state on discrete events, so the Companion cannot be a loaded animation clip. A clip
 * would carry its own baked translation and there is no correct baked translation here.
 *
 * **The degraded path is the return type, not an exception.** `placement: null` is a designed
 * outcome and means the panel opens alone with an edge glyph on the tether. That happens whenever
 * the user has backed into a corner or is nose-to-wall, which is common rather than exotic, so a
 * throw or a forced best-effort placement would both be wrong: one blocks the world, and the other
 * puts the Companion inside geometry. `rejection` carries the tally so the caller can caption the
 * absence honestly rather than inventing a reason.
 *
 * Nothing here reads an island's atlas position as geometry. It reads camera and anchor positions
 * to decide where to draw a presence, which is exactly the presentation use `presentation-metrics`
 * exists to serve. No number produced in this file may reach an answer.
 */

/** The shared up axis. coords.ts fixes it: islands are never pitched or rolled. */
const WORLD_UP: AtlasVec3 = atlasVec3(0, 1, 0);

const cross = (a: AtlasVec3, b: AtlasVec3): AtlasVec3 =>
  atlasVec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Wrap to [-PI, PI]. Without this an arc crossing zero scores as a half-turn relocation. */
function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** Ground-plane bearing, matching the yaw convention in coords.ts. */
const bearing = (fromX: number, fromZ: number, toX: number, toZ: number): number =>
  Math.atan2(toX - fromX, toZ - fromZ);

export interface PlacementConfig {
  /** Candidates swept around the arc. A sweep, not a sample: there is no randomness here. */
  readonly arcSamples: number;
  /** Arc radius as a fraction of the camera-to-subject distance. */
  readonly radiusFactor: number;
  /** Floor and ceiling on that radius, atlas units. */
  readonly minRadius: number;
  readonly maxRadius: number;
  /** Used when there is no focused anchor: the subject becomes a point straight ahead. */
  readonly fallbackSubjectDistance: number;
  /** Horizontal field of view, radians. */
  readonly hFovRad: number;
  /** Viewport aspect, width over height. Derives the vertical field of view. */
  readonly aspect: number;
  /** Fraction of the frustum kept clear at every edge. Nothing may sit half off screen. */
  readonly fovMargin: number;
  /** NDC radius around screen centre that must stay empty, so the reticle is never blocked. */
  readonly reticleClearNdc: number;
  /** Nearest the Companion may stand to the camera, atlas units. */
  readonly minCameraDistance: number;
  /** Radius of the Companion's own body, for the collision proxy test. Atlas units. */
  readonly proxyRadius: number;
  /**
   * Core height relative to the camera, atlas units. Slightly below eye line.
   *
   * The arc is horizontal at one height rather than following the subject's own height, because
   * a Companion that tracked anchor height would bob as focus moved between a doorframe and a
   * kerb. The camera's height is the honest reference: it is the ground plane the user is
   * standing on, and islands share a global up vector so there is only ever one.
   */
  readonly coreHeightOffset: number;
  /** At or beyond this relocation distance, dissolve and reassemble rather than glide. */
  readonly glideMaxDistance: number;
}

export const DEFAULT_PLACEMENT_CONFIG: PlacementConfig = Object.freeze({
  arcSamples: 24,
  radiusFactor: 0.6,
  minRadius: 1.6,
  maxRadius: 8,
  fallbackSubjectDistance: 6,
  hFovRad: (75 * Math.PI) / 180,
  aspect: 16 / 9,
  fovMargin: 0.12,
  reticleClearNdc: 0.22,
  minCameraDistance: 1.4,
  proxyRadius: 0.45,
  coreHeightOffset: -0.25,
  glideMaxDistance: 3,
});

/**
 * Weights for the four terms 4.2 names. They sum to 1 so the score stays readable as a fraction,
 * which matters when a debug overlay prints it next to a rejected candidate.
 */
const WEIGHTS = Object.freeze({
  oppositePanel: 0.35,
  depth: 0.25,
  screenHeight: 0.2,
  angularChange: 0.2,
});

export type RejectionReason =
  | 'behind-camera'
  | 'too-close'
  | 'outside-fov'
  | 'blocks-reticle'
  | 'behind-panel'
  | 'inside-proxy'
  | 'occluded';

export const REJECTION_REASONS: readonly RejectionReason[] = Object.freeze([
  'behind-camera',
  'too-close',
  'outside-fov',
  'blocks-reticle',
  'behind-panel',
  'inside-proxy',
  'occluded',
]);

export type RejectionTally = Readonly<Record<RejectionReason, number>>;

/** A rectangle in normalised device coordinates. Both axes run -1 to 1, centre at the origin. */
export interface ScreenRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Something the Companion may not stand inside. The collision proxy, as spheres. */
export interface Obstacle {
  readonly position: AtlasVec3;
  readonly radius: number;
}

export type Materialization = 'assemble' | 'glide' | 'reassemble';

export interface CompanionPlacement {
  readonly position: AtlasVec3;
  /** Yaw about +Y so the core faces the subject. Matches the coords.ts convention. */
  readonly yaw: number;
  /** How to get there. 4.2: assemble on first appearance, glide near, reassemble far. */
  readonly materialization: Materialization;
  /** The winning score, 0 to 1. For debug overlays, never for a sentence. */
  readonly score: number;
  /** Bearing around the subject, radians. Retained so the next solve can score angular change. */
  readonly arcAngle: number;
}

export interface PlacementResolution {
  /** Null is a designed outcome: the panel opens alone and the tether ends in an edge glyph. */
  readonly placement: CompanionPlacement | null;
  /** Why each candidate died. Lets the caller caption an absence without inventing a reason. */
  readonly rejection: RejectionTally;
  /** How many candidates survived every rejection rule. Zero explains a null placement. */
  readonly survivors: number;
}

export interface PlacementInputs {
  readonly camera: CameraPose;
  /** The focused anchor. Null falls back to a point ahead of the camera, per 4.2. */
  readonly subject: AtlasVec3 | null;
  /** The dialogue panel in NDC. Candidates projecting inside it are rejected. */
  readonly panel: ScreenRect;
  /** Segment visibility against world geometry. Same contract as the focus solver's. */
  readonly visible: VisibilityTest;
  /** The collision proxy. Empty is legal and means nothing to avoid. */
  readonly obstacles: readonly Obstacle[];
  /** Where the Companion stood last, or null on first appearance. */
  readonly previous: AtlasVec3 | null;
}

interface Projected {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
}

/**
 * Camera basis with roll pinned to zero.
 *
 * Right is derived from the shared up vector rather than carried on the pose. A pose that could
 * supply its own up would make a rolled horizon representable, and a rolled horizon is a comfort
 * failure rather than a style choice: the locomotion guidance in 1.5 treats horizon stability as
 * a requirement. Looking straight up or down degenerates the cross product, so that case falls
 * back to a fixed axis instead of returning a zero vector that normalize would pass through.
 */
function basisOf(pose: CameraPose): { right: AtlasVec3; up: AtlasVec3 } {
  const r = cross(pose.forward, WORLD_UP);
  const degenerate = dot(r, r) < 1e-12;
  const right = degenerate ? atlasVec3(1, 0, 0) : normalize(r);
  return { right, up: normalize(cross(right, pose.forward)) };
}

function project(
  pose: CameraPose,
  basis: { right: AtlasVec3; up: AtlasVec3 },
  cfg: PlacementConfig,
  p: AtlasVec3,
): Projected {
  const d = sub(p, pose.position);
  const depth = dot(d, pose.forward);
  if (depth <= 0) return { x: 0, y: 0, depth };
  const tanH = Math.tan(cfg.hFovRad / 2);
  const tanV = tanH / cfg.aspect;
  return { x: dot(d, basis.right) / (depth * tanH), y: dot(d, basis.up) / (depth * tanV), depth };
}

const insideRect = (r: ScreenRect, x: number, y: number): boolean =>
  x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;

/**
 * Resolve a placement, or report honestly that there is none.
 *
 * Rejections run cheapest first and the visibility raycast runs last, because it is the only test
 * that touches world geometry. Reordering it earlier would raycast against candidates already
 * known to be off screen, which is wasted work on every solve rather than an occasional one.
 */
export function resolveCompanionPlacement(
  inputs: PlacementInputs,
  cfg: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): PlacementResolution {
  const { camera, panel, visible, obstacles, previous } = inputs;
  const basis = basisOf(camera);

  const subject =
    inputs.subject ?? add(camera.position, scale(camera.forward, cfg.fallbackSubjectDistance));

  const subjectDepth = Math.max(1e-6, dot(sub(subject, camera.position), camera.forward));
  const radius = Math.min(
    cfg.maxRadius,
    Math.max(cfg.minRadius, atlasDistance(camera.position, subject) * cfg.radiusFactor),
  );
  const coreY = camera.position.y + cfg.coreHeightOffset;

  // The sweep starts at the bearing from the subject back to the camera, so the candidate set is
  // stable in the user's frame. Starting at world zero would be equally deterministic but would
  // rotate the whole candidate set as the user walked around a fixed anchor, which makes the
  // angular-change term compare positions that are not comparable.
  const start = bearing(subject.x, subject.z, camera.position.x, camera.position.z);
  const panelCentreX = (panel.minX + panel.maxX) / 2;
  const panelSide = panelCentreX === 0 ? 0 : Math.sign(panelCentreX);
  const previousAngle =
    previous === null ? null : bearing(subject.x, subject.z, previous.x, previous.z);

  const tally: Record<RejectionReason, number> = {
    'behind-camera': 0,
    'too-close': 0,
    'outside-fov': 0,
    'blocks-reticle': 0,
    'behind-panel': 0,
    'inside-proxy': 0,
    occluded: 0,
  };

  const edge = 1 - cfg.fovMargin;
  let best: CompanionPlacement | null = null;
  let survivors = 0;

  for (let i = 0; i < cfg.arcSamples; i += 1) {
    const theta = start + (i * 2 * Math.PI) / cfg.arcSamples;
    // sin on x and cos on z, matching `bearing`'s atan2(dx, dz). The mirrored pairing sweeps the
    // same circle and every rejection still holds, so a wrong one is invisible in a screenshot;
    // what it breaks is `arcAngle`, which the next solve reads back through `bearing` to score
    // angular change. Two parameterisations there make a small relocation look like a half turn.
    const pos = atlasVec3(
      subject.x + Math.sin(theta) * radius,
      coreY,
      subject.z + Math.cos(theta) * radius,
    );

    const p = project(camera, basis, cfg, pos);
    if (p.depth <= 0) {
      tally['behind-camera'] += 1;
      continue;
    }
    if (atlasDistance(camera.position, pos) < cfg.minCameraDistance) {
      tally['too-close'] += 1;
      continue;
    }
    if (Math.abs(p.x) > edge || Math.abs(p.y) > edge) {
      tally['outside-fov'] += 1;
      continue;
    }
    if (Math.hypot(p.x, p.y) < cfg.reticleClearNdc) {
      tally['blocks-reticle'] += 1;
      continue;
    }
    if (insideRect(panel, p.x, p.y)) {
      tally['behind-panel'] += 1;
      continue;
    }
    if (obstacles.some((o) => atlasDistance(o.position, pos) < o.radius + cfg.proxyRadius)) {
      tally['inside-proxy'] += 1;
      continue;
    }
    if (!visible(camera.position, pos)) {
      tally.occluded += 1;
      continue;
    }

    survivors += 1;

    const opposite = panelSide === 0 ? 0.5 : clamp01((p.x * -panelSide + 1) / 2);
    const depthScore = 1 - Math.min(1, Math.abs(p.depth / subjectDepth - 0.5) * 2);
    const heightScore = 1 - Math.min(1, Math.abs(p.y));
    const angleScore =
      previousAngle === null ? 1 : 1 - Math.abs(wrapAngle(theta - previousAngle)) / Math.PI;

    const score =
      WEIGHTS.oppositePanel * opposite +
      WEIGHTS.depth * depthScore +
      WEIGHTS.screenHeight * heightScore +
      WEIGHTS.angularChange * angleScore;

    // Strictly greater, so the earliest candidate wins a tie. Two solves on identical inputs
    // must return the identical position or the Companion jitters between equal-scoring spots.
    if (best === null || score > best.score) {
      best = {
        position: pos,
        yaw: Math.atan2(-(subject.x - pos.x), -(subject.z - pos.z)),
        materialization: materializationFor(previous, pos, cfg),
        score,
        arcAngle: theta,
      };
    }
  }

  return Object.freeze({ placement: best, rejection: Object.freeze(tally), survivors });
}

/**
 * 4.2: assemble from motes on first appearance, glide for a small relocation, dissolve and
 * reassemble for a large one, and never fly across the user's view. The threshold is the whole
 * decision: above it, a glide would be a traverse, which 4.2 rejects as both an optic-flow cost
 * and an attention theft for its whole duration.
 */
function materializationFor(
  previous: AtlasVec3 | null,
  next: AtlasVec3,
  cfg: PlacementConfig,
): Materialization {
  if (previous === null) return 'assemble';
  return atlasDistance(previous, next) < cfg.glideMaxDistance ? 'glide' : 'reassemble';
}

