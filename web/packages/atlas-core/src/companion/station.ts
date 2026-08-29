import type { AtlasVec3 } from '../coords.js';
import { add, atlasVec3, dot, normalize, scale, sub } from '../coords.js';
import type { CameraPose, VisibilityTest } from '../focus/solver.js';
import { atlasDistance } from '../presentation-metrics.js';
import type {
  CompanionPlacement,
  Materialization,
  Obstacle,
  PlacementConfig,
  ScreenRect,
} from './placement.js';
import { DEFAULT_PLACEMENT_CONFIG, resolveCompanionPlacement } from './placement.js';

/**
 * Home and errand. Where the Companion lives, and when it leaves.
 *
 * interaction-model.md 4.2, as corrected on 2026-08-28. An earlier version of that section ruled
 * out a resting position near the user outright, on the grounds that continuous following reads as
 * a pet. That holds for a Companion which ONLY ever hovers at the shoulder and it is why home is a
 * resting station rather than a leash: nothing here trails the camera during traversal. What it got
 * wrong was the blanket form. A Companion that exists only out in the world is one the user
 * routinely cannot find, and the tether was carrying that whole failure alone.
 *
 * What replaces it:
 *
 *   - **Home.** A fixed offset in the camera's own basis, off the shoulder opposite the panel,
 *     slightly below eye line. Always findable, never hunted for.
 *   - **Errand.** When a turn is about a specific anchor, it detaches and goes to stand beside
 *     that anchor, using the arc solver in `placement.ts`. It returns home when the turn ends.
 *
 * The departure is the expressive act and the reason to build it this way. An agent that walks
 * over to the thing it is asking about is pointing at something inside the user's own memory,
 * which is the product's entire premise performed rather than described.
 *
 * **The travel rule survives intact, and it is what makes this legal.** 4.2 forbids flying across
 * the user's view because a lateral traverse is both an optic-flow cost and an attention theft for
 * its whole duration. An errand is not a lateral traverse: it moves away along the direction the
 * user is already looking, toward a thing already on screen. Radial motion, not lateral. The gate
 * below enforces exactly that distinction rather than trusting it, and a destination that WOULD
 * require a sweep across the view keeps the Companion at home with the tether pointing instead.
 *
 * Under reduced motion it never travels at all. The pointing information the movement carried
 * becomes the caption the caller is obliged to render, which is the accessibility rule applied
 * rather than an exemption from it.
 */

export interface HomeConfig {
  /** Offset along camera right, atlas units. Positive is the side opposite the panel. */
  readonly rightOffset: number;
  /** Offset below the eye line, atlas units. Positive moves it down. */
  readonly downOffset: number;
  /** Offset ahead of the camera, atlas units. Close enough to read as accompanying. */
  readonly forwardOffset: number;
  /**
   * Largest sideways sweep an errand may cost, in NDC across the full frustum width.
   *
   * This is the whole of the "never fly across the user's view" rule, expressed as a number. A
   * destination further sideways than this from home is not travelled to; the Companion stays put
   * and the tether does the pointing.
   */
  readonly maxLateralSweep: number;
}

export const DEFAULT_HOME_CONFIG: HomeConfig = Object.freeze({
  // Far enough that a body of human height reads as company rather than as looming. Measured
  // against the real model rather than guessed: at 2.8 metres the Companion filled about a third
  // of the frame and stood between the user and the region they were looking at. A small drone
  // could sit at arm's length; this one is roughly a person's height, and the offset answers to
  // that rather than the other way round.
  rightOffset: 1.55,
  downOffset: 0.32,
  forwardOffset: 3.8,
  maxLateralSweep: 0.9,
});

export type StationKind = 'home' | 'errand';

/**
 * Why it is at home when there was something it could have gone to.
 *
 * Null when nothing needs explaining. Non-null values are the caller's caption source: 4.2's
 * degradation rule and the project's honest-label rule both forbid an unexplained absence, and
 * inventing a reason at the presentation layer is how invented reasons get shipped.
 */
export type HomeReason =
  | 'no-subject'
  | 'subject-off-screen'
  | 'sweep-too-wide'
  | 'reduced-motion'
  | 'no-placement';

export interface CompanionStation {
  readonly kind: StationKind;
  readonly position: AtlasVec3;
  /** Yaw about +Y. At home it still turns to face the subject: attention is orientation. */
  readonly yaw: number;
  readonly materialization: Materialization;
  readonly homeReason: HomeReason | null;
  /** The errand placement, when it took one. Null at home. Carries the solver's score. */
  readonly placement: CompanionPlacement | null;
}

export interface StationInputs {
  readonly camera: CameraPose;
  /** The anchor this turn is about. Null means there is nothing to point at. */
  readonly subject: AtlasVec3 | null;
  readonly panel: ScreenRect;
  readonly visible: VisibilityTest;
  readonly obstacles: readonly Obstacle[];
  /** Where it stood last, or null on first appearance. */
  readonly previous: CompanionStation | null;
  /** `prefers-reduced-motion`. Suppresses travel entirely. */
  readonly reducedMotion: boolean;
}

const WORLD_UP: AtlasVec3 = atlasVec3(0, 1, 0);

const cross = (a: AtlasVec3, b: AtlasVec3): AtlasVec3 =>
  atlasVec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

/** Camera basis with roll pinned to zero. Same derivation and same reason as in placement.ts. */
function basisOf(pose: CameraPose): { right: AtlasVec3; up: AtlasVec3 } {
  const r = cross(pose.forward, WORLD_UP);
  const right = dot(r, r) < 1e-12 ? atlasVec3(1, 0, 0) : normalize(r);
  return { right, up: normalize(cross(right, pose.forward)) };
}

function ndcX(pose: CameraPose, right: AtlasVec3, cfg: PlacementConfig, p: AtlasVec3): number {
  const d = sub(p, pose.position);
  const depth = dot(d, pose.forward);
  if (depth <= 0) return Number.NaN;
  return dot(d, right) / (depth * Math.tan(cfg.hFovRad / 2));
}

/** Is the subject somewhere the user can already see? An errand to an unseen point is a hunt. */
function onScreen(
  pose: CameraPose,
  basis: { right: AtlasVec3; up: AtlasVec3 },
  cfg: PlacementConfig,
  p: AtlasVec3,
): boolean {
  const d = sub(p, pose.position);
  const depth = dot(d, pose.forward);
  if (depth <= 0) return false;
  const tanH = Math.tan(cfg.hFovRad / 2);
  const x = dot(d, basis.right) / (depth * tanH);
  const y = dot(d, basis.up) / (depth * (tanH / cfg.aspect));
  return Math.abs(x) <= 1 && Math.abs(y) <= 1;
}

/** The shoulder position, in the camera's own basis. */
export function homePosition(pose: CameraPose, home: HomeConfig = DEFAULT_HOME_CONFIG): AtlasVec3 {
  const basis = basisOf(pose);
  return add(
    add(pose.position, scale(basis.right, home.rightOffset)),
    add(scale(basis.up, -home.downOffset), scale(pose.forward, home.forwardOffset)),
  );
}

/** Face a target on the ground plane. Matches the yaw convention in coords.ts. */
function yawToward(from: AtlasVec3, to: AtlasVec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/**
 * Decide where the Companion stands this turn.
 *
 * Errand conditions are all four of: a subject exists, motion is allowed, the subject is already
 * on screen, and the arc solver found somewhere legal to stand. Any failure falls back to home
 * with the reason attached rather than to a compromised errand.
 */
export function resolveStation(
  inputs: StationInputs,
  home: HomeConfig = DEFAULT_HOME_CONFIG,
  cfg: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
): CompanionStation {
  const { camera, subject, previous, reducedMotion } = inputs;
  const basis = basisOf(camera);
  const homePos = homePosition(camera, home);

  const atHome = (reason: HomeReason | null): CompanionStation =>
    Object.freeze({
      kind: 'home' as const,
      position: homePos,
      // Even at home it turns toward what it is asking about. 4.1 expresses attention through
      // core orientation, so a Companion that stayed square to the camera while asking about
      // something off to one side would be saying nothing with the one channel it has.
      yaw: subject === null ? yawToward(homePos, add(homePos, camera.forward)) : yawToward(homePos, subject),
      materialization: transitionFor(previous, homePos, camera, basis, cfg, home),
      homeReason: reason,
      placement: null,
    });

  if (subject === null) return atHome('no-subject');
  if (reducedMotion) return atHome('reduced-motion');
  if (!onScreen(camera, basis, cfg, subject)) return atHome('subject-off-screen');

  const solved = resolveCompanionPlacement(
    {
      camera,
      subject,
      panel: inputs.panel,
      visible: inputs.visible,
      obstacles: inputs.obstacles,
      previous: previous?.position ?? null,
    },
    cfg,
  );
  if (solved.placement === null) return atHome('no-placement');

  // The lateral gate. Measured from HOME rather than from the previous position, because home is
  // where an errand departs from and it is the sweep the user actually watches.
  const sweep = Math.abs(
    ndcX(camera, basis.right, cfg, solved.placement.position) -
      ndcX(camera, basis.right, cfg, homePos),
  );
  if (!Number.isFinite(sweep) || sweep > home.maxLateralSweep) return atHome('sweep-too-wide');

  return Object.freeze({
    kind: 'errand' as const,
    position: solved.placement.position,
    yaw: solved.placement.yaw,
    materialization: transitionFor(previous, solved.placement.position, camera, basis, cfg, home),
    homeReason: null,
    placement: solved.placement,
  });
}

/**
 * How it gets there.
 *
 * Distance alone is not enough. A short move can still cross the middle of the view, and a glide
 * across the view is the one thing 4.2 rules out outright, so a wide sweep forces a dissolve and
 * reassemble no matter how near the destination is.
 */
function transitionFor(
  previous: CompanionStation | null,
  next: AtlasVec3,
  camera: CameraPose,
  basis: { right: AtlasVec3; up: AtlasVec3 },
  cfg: PlacementConfig,
  home: HomeConfig,
): Materialization {
  if (previous === null) return 'assemble';
  const sweep = Math.abs(
    ndcX(camera, basis.right, cfg, next) - ndcX(camera, basis.right, cfg, previous.position),
  );
  if (!Number.isFinite(sweep) || sweep > home.maxLateralSweep) return 'reassemble';
  return atlasDistance(previous.position, next) < cfg.glideMaxDistance ? 'glide' : 'reassemble';
}
