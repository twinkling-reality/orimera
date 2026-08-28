import { describe, expect, it } from 'vitest';

import { ANCHOR_MOTE_CAP, companionFigure, formationFigure, unformedAtlasFigure } from '../src/field/figures.js';
import { KIND, type Figure } from '../src/field/figure.js';
import type { FormationVisual } from '../src/formation/index.js';

function countKind(f: Figure, kind: number): number {
  let n = 0;
  for (let i = 0; i < f.count; i += 1) if (f.kind[i] === kind) n += 1;
  return n;
}

function visual(over: Partial<FormationVisual>): FormationVisual {
  return {
    figure: 'anchors',
    motion: 'advance',
    resolved: 1,
    anchorMotes: 0,
    threads: 0,
    dissolve: 0,
    ...over,
  };
}

describe('the compositions are deterministic and bounded', () => {
  it('never exceeds the field capacity', () => {
    for (const f of [companionFigure(900), unformedAtlasFigure(900), formationFigure(900, visual({}))]) {
      expect(f.count).toBeLessThanOrEqual(900);
    }
  });

  it('produces the same points on every call, so a composition can be reviewed', () => {
    const a = companionFigure(400);
    const b = companionFigure(400);
    expect(Array.from(a.xy.slice(0, 200))).toEqual(Array.from(b.xy.slice(0, 200)));
  });

  it('gives the Companion a core and rings', () => {
    const f = companionFigure(1200);
    expect(countKind(f, KIND.CORE)).toBeGreaterThan(0);
    expect(countKind(f, KIND.RING)).toBeGreaterThan(countKind(f, KIND.CORE));
  });
});

describe('formation geometry carries real counts and nothing else', () => {
  it('draws one anchor mote per detection, up to the legibility cap', () => {
    const f = formationFigure(1400, visual({ figure: 'anchors', anchorMotes: 18 }));
    expect(countKind(f, KIND.RING) + countKind(f, KIND.UNCONFIRMED)).toBe(18);

    const capped = formationFigure(1400, visual({ figure: 'anchors', anchorMotes: 500 }));
    expect(countKind(capped, KIND.RING) + countKind(capped, KIND.UNCONFIRMED)).toBe(ANCHOR_MOTE_CAP);
  });

  it('makes exactly the dissolve share read as unconfirmed', () => {
    const f = formationFigure(1400, visual({ figure: 'anchors', anchorMotes: 20, dissolve: 0.5 }));
    expect(countKind(f, KIND.UNCONFIRMED)).toBe(10);
    expect(countKind(f, KIND.RING)).toBe(10);
  });

  it('draws one thread per compared candidate link', () => {
    const none = formationFigure(1400, visual({ figure: 'threads', threads: 0 }));
    const two = formationFigure(1400, visual({ figure: 'threads', threads: 2 }));
    expect(countKind(none, KIND.STRUCTURE)).toBe(0);
    expect(countKind(two, KIND.STRUCTURE)).toBeGreaterThan(0);
    expect(countKind(two, KIND.STRUCTURE)).toBe(2 * (countKind(two, KIND.STRUCTURE) / 2));
  });

  it('migrates nothing onto surfaces when no fraction was measured', () => {
    // With `resolved: null` the surface pass leaves every point loose in the volume, so the
    // silhouette does not resolve. The label says so in words at the same moment.
    const unmeasured = formationFigure(1400, visual({ figure: 'surfaces', resolved: null }));
    const measured = formationFigure(1400, visual({ figure: 'surfaces', resolved: 1 }));
    const spread = (f: Figure): number => {
      let sum = 0;
      for (let i = 0; i < f.count; i += 1) sum += Math.abs(f.xy[i * 2] ?? 0);
      return sum / f.count;
    };
    expect(spread(unmeasured)).not.toBeCloseTo(spread(measured), 2);
  });
});
