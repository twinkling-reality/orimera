/**
 * Whether a frame is worth drawing.
 *
 * Redrawing an identical picture sixty times a second is the difference between a machine whose
 * fan runs for the whole working session and one whose does not. The decision is pure and lives
 * here, away from the graphics device, because the failure it can cause is not a crash: a wrong
 * answer is a world that silently stops updating, which looks like a hang and is exactly the kind
 * of bug that is invisible until somebody notices the screen is stale.
 *
 * The bias is therefore toward drawing. A surplus frame costs what every frame used to cost; a
 * missing one costs the illusion that the world is running at all.
 */

/**
 * Idle cadences, in milliseconds.
 *
 * A settled world still has work arriving that no camera movement announces: source photographs
 * decode asynchronously, veil resolve eases toward its target over about a second, and residency
 * swaps land whenever the planner finishes. Stopping dead on a still camera would freeze all of
 * that half-finished, so the floor is a slow heartbeat rather than zero.
 *
 * Ambient motion is slow drift and breathing, which reads the same at thirty as at sixty. With
 * reduced motion the world genuinely holds still, so the floor drops to a rate that exists only
 * so late arrivals can appear.
 */
export const IDLE_FRAME_MS = 1000 / 30;
export const SETTLED_FRAME_MS = 1000 / 4;

export interface FramePolicyInput {
  /** Something changed the picture without moving the camera: profile, theme, Map, residency. */
  readonly dirty: boolean;
  /** Direct travel owns the camera and moves it every tick. */
  readonly navigating: boolean;
  /** The camera pose differs from what is currently on screen. */
  readonly poseChanged: boolean;
  /** Access preference. Ambient world motion is off, so a settled world is genuinely still. */
  readonly reducedMotion: boolean;
  /** Milliseconds since the last drawn frame. Negative means nothing has been drawn yet. */
  readonly sinceLastRenderMs: number;
}

export function shouldDrawFrame(input: FramePolicyInput): boolean {
  if (input.dirty || input.navigating || input.poseChanged) return true;
  if (!Number.isFinite(input.sinceLastRenderMs) || input.sinceLastRenderMs < 0) return true;
  return input.sinceLastRenderMs >= (input.reducedMotion ? SETTLED_FRAME_MS : IDLE_FRAME_MS);
}
