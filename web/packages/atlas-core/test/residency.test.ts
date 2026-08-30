import { describe, expect, it } from 'vitest';
import {
  EMPTY_RESIDENCY_STATE,
  atlasVec3,
  buildNeighborhoodIndex,
  completeResidencyRequest,
  islandId,
  localVec3,
  makeIsland,
  makeScene,
  planResidency,
  placement,
  residencyDemandsForView,
  type ResidencyAsset,
  type ResidencyDemand,
  type ResidencyState,
} from '../src/index.js';

const asset = (id: string, scale = 1): ResidencyAsset => ({
  islandId: islandId(id),
  cost: { stub: 0, proxy: 2 * scale, coarse: 5 * scale, full: 10 * scale },
});
const demand = (
  id: string,
  desired: ResidencyDemand['desired'],
  priority: number,
  pin = false,
): ResidencyDemand => ({ islandId: islandId(id), desired, priority, pin });

function finishLoads(state: ResidencyState): ResidencyState {
  let next = state;
  for (const entry of state.entries.values()) {
    if (entry.pending !== null) next = completeResidencyRequest(next, entry.pending.requestId, true);
  }
  return next;
}

describe('budgeted residency planning', () => {
  it('pins a navigation target before lower-priority detail and stays inside budget', () => {
    const plan = planResidency(
      [asset('target'), asset('near'), asset('far')],
      [demand('far', 'full', 1), demand('near', 'coarse', 20), demand('target', 'proxy', 5, true)],
      { maxCost: 8 },
    );
    expect(plan.allocated.get(islandId('target'))).toBe('proxy');
    expect(plan.allocated.get(islandId('near'))).toBe('coarse');
    expect(plan.allocated.get(islandId('far'))).toBe('stub');
    expect(plan.reservedCost).toBeLessThanOrEqual(8);
    expect(plan.deferred.map((value) => value.islandId)).toContain(islandId('far'));
  });

  it('merges a low-detail pin without discarding a higher-detail demand', () => {
    const plan = planResidency(
      [asset('target')],
      [demand('target', 'full', 200), demand('target', 'proxy', 10_000, true)],
      { maxCost: 10 },
    );
    expect(plan.allocated.get(islandId('target'))).toBe('full');
    expect(plan.deferred).toHaveLength(0);
  });

  it('degrades a pinned target to the best affordable stage instead of dropping it to a stub', () => {
    const plan = planResidency(
      [asset('target')],
      [demand('target', 'full', 10_000, true)],
      { maxCost: 5 },
    );
    expect(plan.allocated.get(islandId('target'))).toBe('coarse');
    expect(plan.deferred.map((value) => value.islandId)).toEqual([islandId('target')]);
    expect(plan.reservedCost).toBe(5);
  });

  it('cancels a stale in-flight request when the target changes', () => {
    const first = planResidency([asset('a')], [demand('a', 'full', 1)], { maxCost: 20 });
    const request = first.state.entries.get(islandId('a'))!.pending!;
    const second = planResidency([asset('a')], [], { maxCost: 20, graceRevisions: 0 }, first.state);
    expect(second.actions).toContainEqual({
      type: 'cancel',
      requestId: request.requestId,
      islandId: islandId('a'),
    });
    expect(completeResidencyRequest(second.state, request.requestId, true)).toBe(second.state);
  });

  it('retains loaded detail for the grace window and releases it after', () => {
    const loadedPlan = planResidency([asset('a')], [demand('a', 'coarse', 1)], { maxCost: 20 });
    const loaded = finishLoads(loadedPlan.state);
    const warm = planResidency([asset('a')], [], { maxCost: 20, graceRevisions: 2 }, loaded);
    expect(warm.allocated.get(islandId('a'))).toBe('coarse');
    const warmAgain = planResidency([asset('a')], [], { maxCost: 20, graceRevisions: 2 }, warm.state);
    expect(warmAgain.allocated.get(islandId('a'))).toBe('coarse');
    const cold = planResidency([asset('a')], [], { maxCost: 20, graceRevisions: 2 }, warmAgain.state);
    expect(cold.allocated.get(islandId('a'))).toBe('stub');
    expect(cold.actions.some((action) => action.type === 'release')).toBe(true);
  });

  it('derives current-neighborhood, adjacent-halo, and target demands without geography', () => {
    const islands = Array.from({ length: 4 }, (_value, index) => makeIsland({
      islandId: islandId(`r${index}`),
      creationOrdinal: index,
      createdAt: index,
      placement: placement(atlasVec3(index * 100, 0, 0), 0, 1),
      rung: 4,
      scaleIsMetric: false,
      footprintRadiusLocal: 3,
      viewpointLocal: localVec3(0, 1.6, 0),
      anchors: [],
      layoutEntities: new Set(index < 2 ? ['shared' as never] : []),
    }));
    const index = buildNeighborhoodIndex(makeScene(islands, 1, 1), { capacity: 2 });
    const active = index.neighborhoodOf.get(islandId('r0'))!;
    const demands = residencyDemandsForView(index, {
      map: false,
      activeNeighborhood: active,
      tier: { tier: new Map([[islandId('r0'), 3]]) },
      target: islandId('r3'),
    });
    expect(demands.find((value) => value.islandId === islandId('r0'))?.desired).toBe('full');
    expect(demands.find((value) => value.islandId === islandId('r3'))?.pin).toBe(true);
  });

  it('plans hundreds of assets deterministically under a fixed budget', () => {
    const catalog = Array.from({ length: 300 }, (_value, index) => asset(`r${index}`, 1 + index % 3));
    const demands = catalog.map((value, index) => demand(
      value.islandId,
      index % 4 === 0 ? 'full' : 'proxy',
      index % 17,
    ));
    const a = planResidency(catalog, demands, { maxCost: 240 }, EMPTY_RESIDENCY_STATE);
    const b = planResidency(catalog, demands, { maxCost: 240 }, EMPTY_RESIDENCY_STATE);
    expect(a.reservedCost).toBeLessThanOrEqual(240);
    expect([...a.allocated]).toEqual([...b.allocated]);
    expect(a.actions).toEqual(b.actions);
  });
});
