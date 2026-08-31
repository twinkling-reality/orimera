import { describe, expect, it } from 'vitest';
import {
  RepresentationPressureController,
  islandId,
  planResidency,
} from '../src/index.js';

describe('measurement-driven representation pressure', () => {
  it('downgrades only after sustained measured overload and recovers slowly', () => {
    const pressure = new RepresentationPressureController({ windowSize: 4, frameBudgetMs: 16 });
    for (let index = 0; index < 7; index += 1) {
      expect(pressure.record({ frameTimeMs: 30 }).changed).toBe(false);
    }
    expect(pressure.record({ frameTimeMs: 30 }).state).toMatchObject({
      level: 1, maxStage: 'coarse', budgetScale: 0.72,
    });
    for (let index = 0; index < 19; index += 1) {
      expect(pressure.record({ frameTimeMs: 10 }).changed).toBe(false);
    }
    expect(pressure.record({ frameTimeMs: 10 }).state.level).toBe(0);
  });

  it('uses observed resource pressure and caps a pinned representation honestly', () => {
    const pressure = new RepresentationPressureController({ windowSize: 4 });
    for (let index = 0; index < 8; index += 1) {
      pressure.record({ frameTimeMs: 12, resourceRatio: 0.97 });
    }
    const id = islandId('target');
    const plan = planResidency(
      [{ islandId: id, cost: { stub: 0, proxy: 2, coarse: 5, full: 10 } }],
      [{ islandId: id, desired: 'full', priority: 100, pin: true }],
      { maxCost: 100, maxStage: pressure.state.maxStage },
    );
    expect(plan.allocated.get(id)).toBe('coarse');
    expect(plan.deferred).toHaveLength(1);
  });

  it('validates measurements rather than guessing missing hardware facts', () => {
    const pressure = new RepresentationPressureController({ windowSize: 4 });
    expect(() => pressure.record({ frameTimeMs: Number.NaN })).toThrow(/frame time/);
    expect(() => pressure.record({ frameTimeMs: 10, resourceRatio: -1 })).toThrow(/resource ratio/);
  });
});
