// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCompanionStage } from '../src/ui/companion-stage.js';
import { MOTE_STATE_CAPTIONS } from '../src/ui/companion-motes.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('the Companion under reduced motion', () => {
  it('renders a visible caption carrying the state information', () => {
    const media = {
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } satisfies MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);

    const parent = document.createElement('div');
    document.body.append(parent);
    const stage = buildCompanionStage({ parent });
    const caption = stage.root.querySelector<HTMLParagraphElement>('.companion-motion-caption');

    expect(stage.root.hasAttribute('data-reduced-motion')).toBe(true);
    expect(caption?.hidden).toBe(false);
    expect(caption?.textContent).toBe(MOTE_STATE_CAPTIONS.resting);

    stage.setState('uncertain');
    expect(caption?.textContent).toBe(MOTE_STATE_CAPTIONS.uncertain);
    expect(caption?.textContent?.toLowerCase()).toContain('unconfirmed');
    stage.dispose();
    expect(media.removeEventListener).toHaveBeenCalledOnce();
  });
});
