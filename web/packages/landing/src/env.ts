/**
 * Platform facts the page has to respect, read once and watched for change.
 *
 * `prefers-reduced-motion` is watched rather than sampled at load because a user can change it
 * mid-session, and interaction-model.md 2.4 says every comfort setting is initialized from the
 * platform. VERIFIED, quoted there: the media feature detects "if a user has enabled a setting on
 * their device to minimize the amount of non-essential motion".
 * https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
 */

export interface Env {
  reducedMotion: boolean;
  /** Device pixel ratio, capped. The field is soft by design and gains nothing above 1.5. */
  readonly dpr: number;
  /** Pointer lock is unsupported on iOS Safari and Android Chrome (interaction-model.md 2.1). */
  readonly pointerLockAvailable: boolean;
}

export const DPR_CAP = 1.5;

export function readEnv(): Env {
  return {
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    dpr: Math.min(DPR_CAP, window.devicePixelRatio || 1),
    pointerLockAvailable: 'pointerLockElement' in document && 'requestPointerLock' in Element.prototype,
  };
}

export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const handler = (e: MediaQueryListEvent): void => onChange(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/**
 * Particle count.
 *
 * Fixed per session rather than adaptive, because a field that quietly thins out when the machine
 * is busy is a composition that cannot be reviewed. The value is chosen for the stated target
 * (Apple M3 Pro, Chrome) and measured there; the half-resolution mask in the renderer is what
 * keeps it cheap, not a small count.
 */
export function particleCount(reducedMotion: boolean): number {
  // Under reduced motion nothing integrates, so the count is a pure fill-rate question and can be
  // a little higher: a still composition benefits from the extra density it can now afford.
  return reducedMotion ? 1800 : 1500;
}
