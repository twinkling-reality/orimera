// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildStatus } from '../src/ui/status.js';

describe('reconstruction rung disclosure', () => {
  it('keeps the recorded gate result separate from the substrate this browser displays', () => {
    const status = buildStatus({
      omittedRegionCount: 0,
      undrawable: new Map(),
      reconstructionScenes: [{
        sceneId: 'scene-1',
        recordedRung: 3,
        displayedRung: 4,
        registeredMemberCount: 2,
        memberCount: 3,
        renderingSubstrate: 'source_photographs',
        reasons: [
          'Rung 2 withheld: no measured corridor receipt is available.',
          'This browser could not load a verified posed map.',
        ],
      }],
    });

    expect(status.querySelector('summary')?.textContent).toBe(
      'Recorded rung 3; showing rung 4 from source photographs.',
    );
    expect(status.querySelector('p')?.textContent).toBe('2 of 3 photographs registered.');
    expect([...status.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Rung 2 withheld: no measured corridor receipt is available.',
      'This browser could not load a verified posed map.',
    ]);
  });
});
