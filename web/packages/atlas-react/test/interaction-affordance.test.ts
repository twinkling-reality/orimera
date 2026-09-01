import { describe, expect, it } from 'vitest';
import {
  FULL_INTERACTION_LABEL_DISTANCE,
  resolveInteractionAffordance,
} from '../src/playcanvas/interaction-affordance.js';

describe('the staged world interaction affordance', () => {
  it('draws no interface when the reticle has no candidate', () => {
    expect(resolveInteractionAffordance({
      signalIndex: null,
      candidateIndex: null,
      focusedIndex: null,
      focusedDistance: null,
    })).toBe('hidden');
  });

  it('shows only the sigil while focus dwell is still settling', () => {
    expect(resolveInteractionAffordance({
      signalIndex: 2,
      candidateIndex: 2,
      focusedIndex: null,
      focusedDistance: null,
    })).toBe('signal');
  });

  it('shows the distance sigil before the interactable enters the aim cone', () => {
    expect(resolveInteractionAffordance({
      signalIndex: 2,
      candidateIndex: null,
      focusedIndex: null,
      focusedDistance: null,
    })).toBe('signal');
  });

  it('shows only the key when the settled target is not yet close', () => {
    expect(resolveInteractionAffordance({
      signalIndex: 2,
      candidateIndex: 2,
      focusedIndex: 2,
      focusedDistance: FULL_INTERACTION_LABEL_DISTANCE + 0.1,
    })).toBe('key');
  });

  it('expands to the full verb at the authored close-approach distance', () => {
    expect(resolveInteractionAffordance({
      signalIndex: 2,
      candidateIndex: 2,
      focusedIndex: 2,
      focusedDistance: FULL_INTERACTION_LABEL_DISTANCE,
    })).toBe('label');
  });

  it('never labels a stale incumbent after the reticle chooses another candidate', () => {
    expect(resolveInteractionAffordance({
      signalIndex: 3,
      candidateIndex: 3,
      focusedIndex: 2,
      focusedDistance: 2,
    })).toBe('signal');
  });
});
