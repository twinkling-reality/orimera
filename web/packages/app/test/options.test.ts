// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/preferences.js';
import { buildOptions } from '../src/ui/options.js';

describe('Options', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('shows only settings that emit a live preference change', () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    const view = buildOptions({
      preferences: DEFAULT_PREFERENCES,
      onChange,
      onPreview,
      onClose: vi.fn(),
      onShowControls: vi.fn(),
    });
    document.body.append(view.root);

    const contrast = view.root.querySelector<HTMLSelectElement>('[aria-label="Contrast"]')!;
    contrast.value = 'high';
    contrast.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ contrast: 'high' }));

    expect(view.root.querySelector('[aria-label="World form"]')).toBeNull();
    expect(view.root.textContent).not.toContain('Blue Hour');

    const vitality = view.root.querySelector<HTMLInputElement>('[aria-label="Color vitality"]')!;
    expect(vitality).not.toBeNull();
    vitality.value = '0.4';
    vitality.dispatchEvent(new Event('input'));
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({
      worldStyleParameters: expect.objectContaining({ vitality: 0.4 }),
    }));
    expect(view.root.textContent).toContain('Previewing · not saved');
    expect(view.root.textContent).toContain('Always protected');
    expect(view.root.textContent).toContain('Conversation-made designs are not connected');
    expect(view.root.querySelector('[aria-label="Surface finish"]')).not.toBeNull();
    [...view.root.querySelectorAll('button')]
      .find((button) => button.textContent === 'Apply world design')!
      .click();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      worldStyleParameters: expect.objectContaining({ vitality: 0.4 }),
    }));
    expect(view.root.textContent).toContain('Personal variation');

    const fieldOfView = view.root.querySelector<HTMLInputElement>('[aria-label="Field of view"]')!;
    fieldOfView.value = '82';
    fieldOfView.dispatchEvent(new Event('input'));
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ fieldOfView: 82 }));
    expect(onChange).not.toHaveBeenLastCalledWith(expect.objectContaining({ fieldOfView: 82 }));
    fieldOfView.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ fieldOfView: 82 }));

    const shape = view.root.querySelector<HTMLSelectElement>('[aria-label="Companion shape"]')!;
    shape.value = 'cloud';
    shape.dispatchEvent(new Event('change'));
    const color = view.root.querySelector<HTMLSelectElement>('[aria-label="Companion color"]')!;
    color.value = 'periwinkle';
    color.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      companionBody: 'cloud',
      companionColor: 'periwinkle',
    }));
  });

  it('keeps world edits as a reversible preview until explicitly applied', () => {
    const onPreview = vi.fn();
    const onWorldDiscard = vi.fn();
    const onChange = vi.fn();
    const view = buildOptions({
      preferences: DEFAULT_PREFERENCES,
      onChange,
      onPreview,
      onWorldDiscard,
      onClose: vi.fn(),
      onShowControls: vi.fn(),
    });
    document.body.append(view.root);

    const finish = view.root.querySelector<HTMLSelectElement>('[aria-label="Surface finish"]')!;
    finish.value = 'clear-lens';
    finish.dispatchEvent(new Event('change'));
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({
      worldStyleParameters: expect.objectContaining({ 'surface-finish': 'clear-lens' }),
    }));
    expect(onChange).not.toHaveBeenCalled();

    [...view.root.querySelectorAll('button')]
      .find((button) => button.textContent === 'Undo preview')!
      .click();
    expect(onWorldDiscard).toHaveBeenCalledWith(DEFAULT_PREFERENCES);
    expect(view.preferences().worldStyleParameters['surface-finish']).toBe('source-paper');
    expect(view.root.textContent).toContain('Authored default');
  });

  it('reports whether a reviewed choice is durable without hiding the live device result', () => {
    const view = buildOptions({
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      onClose: vi.fn(),
      onShowControls: vi.fn(),
    });
    document.body.append(view.root);
    view.reportPersistence('saving');
    expect(view.root.textContent).toContain('Saving this reviewed choice');
    view.reportPersistence('failed');
    expect(view.root.textContent).toContain('Applied on this device, but not saved');
  });

  it('moves focus into the dialog and restores it on return', () => {
    const prior = document.createElement('button');
    document.body.append(prior);
    prior.focus();
    const view = buildOptions({
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      onClose: vi.fn(),
      onShowControls: vi.fn(),
    });
    document.body.append(view.root);
    view.setVisible(true);
    expect(view.root.hidden).toBe(false);
    expect(document.activeElement).toBe(view.root.querySelector('.overlay-close'));
    view.setVisible(false);
    expect(document.activeElement).toBe(prior);
  });

  it('keeps Tab inside the modal without taking Escape', () => {
    const view = buildOptions({
      preferences: DEFAULT_PREFERENCES,
      onChange: vi.fn(),
      onClose: vi.fn(),
      onShowControls: vi.fn(),
    });
    document.body.append(view.root);
    view.setVisible(true);
    const focusable = [...view.root.querySelectorAll<HTMLElement>('button, input, select')];
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true,
    }));
    expect(document.activeElement).toBe(last);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.root.hidden).toBe(false);
  });

  it('restores the authored defaults as one preference object', () => {
    const onChange = vi.fn();
    const view = buildOptions({
      preferences: { ...DEFAULT_PREFERENCES, appearance: 'dawn', fieldOfView: 88 },
      onChange,
      onClose: vi.fn(),
      onShowControls: vi.fn(),
    });
    document.body.append(view.root);
    [...view.root.querySelectorAll('button')]
      .find((button) => button.textContent === 'Restore defaults')!
      .click();
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_PREFERENCES);
  });
});
