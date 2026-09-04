// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChrome } from '../src/ui/chrome.js';
import { buildTitle } from '../src/ui/title.js';
import { buildViewportBoundary } from '../src/ui/viewport-boundary.js';

describe('the Exulanica title screen', () => {
  beforeEach(() => document.body.replaceChildren());

  it('presents one primary wordmark and one decorative memory aperture', () => {
    const title = buildTitle();

    expect(title.querySelector('h1')?.textContent).toBe('Exulanica');
    expect(title.getAttribute('aria-labelledby')).toBe('title-wordmark');
    expect(title.querySelector('.proposition')?.textContent).toBe(
      'A personal world memory model',
    );
    expect(title.querySelectorAll('.memory-aperture')).toHaveLength(1);
    expect(title.querySelector('.memory-aperture')?.getAttribute('aria-hidden')).toBe('true');
    expect(title.querySelectorAll('img')).toHaveLength(0);
    expect(title.querySelector('.publisher-mark')?.textContent).toBe(
      '© 2026 Twinkling Reality',
    );
  });

  it('keeps the title menu semantic and preserves the keyboard destination ids', () => {
    const onHome = vi.fn();
    const onMethod = vi.fn();
    const chrome = buildChrome({
      atlasHref: 'https://atlas.example/session',
      onHome,
      onMethod,
    });

    const atlas = chrome.root.querySelector<HTMLAnchorElement>('#path-enter');
    const method = chrome.root.querySelector<HTMLButtonElement>('#path-how');
    const docs = chrome.root.querySelector<HTMLAnchorElement>('#path-docs');
    const home = chrome.root.querySelector<HTMLButtonElement>('#path-home');
    const marker = chrome.root.querySelector<SVGSVGElement>('.companion-menu-marker');

    expect(chrome.root.tagName).toBe('NAV');
    expect(chrome.root.getAttribute('aria-label')).toBe('Primary navigation');
    expect(atlas?.textContent).toContain('Enter Atlas');
    expect(atlas?.href).toBe('https://atlas.example/session');
    expect(method?.tagName).toBe('BUTTON');
    expect(docs?.textContent).toContain('Documentation');
    expect(chrome.root.querySelectorAll('.companion-menu-marker')).toHaveLength(1);
    expect(marker?.getAttribute('aria-hidden')).toBe('true');
    expect(marker?.getAttribute('focusable')).toBe('false');
    expect(marker?.hasAttribute('tabindex')).toBe(false);
    expect(marker?.querySelectorAll('.companion-menu-wake')).toHaveLength(1);

    chrome.setSurface('title');
    expect(home?.hidden).toBe(true);
    expect(atlas?.hidden).toBe(false);
    expect(method?.hasAttribute('aria-current')).toBe(false);
    expect(marker?.hasAttribute('hidden')).toBe(false);
    expect(marker?.dataset['target']).toBe('path-enter');

    method?.dispatchEvent(new PointerEvent('pointerenter'));
    expect(marker?.dataset['target']).toBe('path-how');
    expect(marker?.dataset['motion']).toMatch(/^down-/);
    docs?.dispatchEvent(new FocusEvent('focus'));
    atlas?.dispatchEvent(new PointerEvent('pointerenter'));
    expect(marker?.dataset['target']).toBe('path-docs');
    expect(marker?.dataset['state']).toBe('attending');
    expect(marker?.dataset['motion']).toMatch(/^down-/);
    docs?.dispatchEvent(new FocusEvent('blur'));
    expect(marker?.dataset['target']).toBe('path-enter');
    expect(marker?.dataset['motion']).toMatch(/^up-/);

    chrome.setSurface('method');
    expect(home?.hidden).toBe(false);
    expect(atlas?.hidden).toBe(true);
    expect(method?.getAttribute('aria-current')).toBe('page');
    expect(marker?.hasAttribute('hidden')).toBe(true);
  });

  it('uses the public product name in the desktop boundary', () => {
    const boundary = buildViewportBoundary();
    expect(boundary.root.querySelector('.boundary-eyebrow')?.textContent).toBe('Exulanica');
  });

  it('rests at the first actionable station when Atlas is disconnected', () => {
    const chrome = buildChrome({
      atlasHref: null,
      onHome: vi.fn(),
      onMethod: vi.fn(),
    });
    const marker = chrome.root.querySelector<SVGSVGElement>('.companion-menu-marker');

    chrome.setSurface('title');
    expect(chrome.root.querySelector('#path-enter')).toBeNull();
    expect(chrome.root.querySelector('[role="status"]')?.textContent).toContain('not connected');
    expect(marker?.dataset['target']).toBe('path-how');
  });
});
