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
  /** Pointer lock is unsupported on iOS Safari and Android Chrome (interaction-model.md 2.1). */
  readonly pointerLockAvailable: boolean;
}

export function readEnv(): Env {
  return {
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    pointerLockAvailable: 'pointerLockElement' in document && 'requestPointerLock' in Element.prototype,
  };
}

export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const handler = (e: MediaQueryListEvent): void => onChange(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
