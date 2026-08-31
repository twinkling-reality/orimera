// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { buildAtlasCommands } from '../src/ui/atlas-commands.js';

describe('Atlas command strip', () => {
  it('makes every system command clickable and reflects the active surface', () => {
    const onCommand = vi.fn();
    const view = buildAtlasCommands(onCommand);
    document.body.replaceChildren(view.root);
    const options = view.root.querySelector<HTMLButtonElement>('[data-command="options"]')!;
    options.click();
    expect(onCommand).toHaveBeenCalledWith('options');

    view.reflect('options', 'ground');
    expect(options.getAttribute('aria-current')).toBe('page');
    expect(view.root.querySelector('[data-command="map"]')?.hasAttribute('aria-current')).toBe(false);

    view.reflect('world', 'map');
    expect(view.root.querySelector('[data-command="map"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('temporarily explains the evidence and relationship commands without changing their buttons', () => {
    const view = buildAtlasCommands(vi.fn());
    const buttonCount = view.root.querySelectorAll('button').length;
    view.setFirstUseVisible(true);
    expect(view.root.querySelector('.atlas-command-guide')?.hasAttribute('hidden')).toBe(false);
    expect(view.root.querySelector('.atlas-command-guide')?.textContent).toContain('Index evidence');
    expect(view.root.querySelector('.atlas-command-guide')?.textContent).toContain('Map relationships');
    expect(view.root.querySelectorAll('button')).toHaveLength(buttonCount);
    view.setFirstUseVisible(false);
    expect(view.root.querySelector('.atlas-command-guide')?.hasAttribute('hidden')).toBe(true);
  });
});
