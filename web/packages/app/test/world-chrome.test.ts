// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { COMPANION_SIDE_KEY, buildWorldChrome } from '../src/ui/world-chrome.js';

describe('world chrome companion side', () => {
  it('reads and writes only the Exulanica companion side key', () => {
    window.localStorage.clear();
    window.localStorage.setItem(COMPANION_SIDE_KEY, 'left');
    const chrome = buildWorldChrome(document.createElement('div'));
    expect(chrome.companionSide()).toBe('left');
    chrome.toggleCompanionSide();
    expect(chrome.companionSide()).toBe('right');
    expect(window.localStorage.getItem(COMPANION_SIDE_KEY)).toBe('right');
  });
});
