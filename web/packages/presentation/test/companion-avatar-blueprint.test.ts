import { describe, expect, it } from 'vitest';
import {
  companionAppearanceConfiguration,
  companionAvatarBlueprint,
} from '../src/index.js';

describe('Companion avatar blueprint', () => {
  it('resolves renderer-neutral geometry from the versioned appearance contract', () => {
    const appearance = companionAppearanceConfiguration({
      body: 'cloud',
      color: 'mint',
      face: 'curious',
    });
    const blueprint = companionAvatarBlueprint(appearance);

    expect(blueprint.viewBox).toBe('0 0 240 240');
    expect(blueprint.bodyPath).toMatch(/^M/);
    expect(blueprint.eyePose.left).toHaveLength(5);
    expect(blueprint.eyePose.right).toHaveLength(5);
    expect(Object.isFrozen(blueprint)).toBe(true);
  });
});
