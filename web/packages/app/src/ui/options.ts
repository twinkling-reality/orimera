import {
  DEFAULT_PREFERENCES,
  normalisePreferences,
  type AtlasPreferences,
  type ContrastPreference,
  type TransparencyPreference,
  type VignettePreference,
} from '../preferences.js';
import {
  worldArtProfile,
  worldStyleControls,
} from '@orimera/presentation';
import type { WorldStyleParameterDefinition, WorldStyleParameterValue } from '@orimera/atlas-core';
import { el } from './dom.js';
import { createModalFocus } from './modal-focus.js';

export interface OptionsView {
  readonly root: HTMLElement;
  preferences(): AtlasPreferences;
  setPreferences(value: AtlasPreferences): void;
  setVisible(visible: boolean): void;
}

interface OptionsCallbacks {
  readonly preferences: AtlasPreferences;
  readonly onChange: (preferences: AtlasPreferences) => void;
  readonly onPreview?: (preferences: AtlasPreferences) => void;
  readonly onClose: () => void;
  readonly onShowControls: () => void;
}

function option(value: string, label: string): HTMLOptionElement {
  return el('option', { value, text: label });
}

function field(label: string, control: HTMLElement, note?: string): HTMLElement {
  const content: Node[] = [el('span', { class: 'option-label', text: label }), control];
  if (note !== undefined) content.push(el('span', { class: 'option-note', text: note }));
  return el('label', { class: 'option-field' }, content);
}

export function buildOptions(callbacks: OptionsCallbacks): OptionsView {
  const root = el('section', {
    class: 'system-overlay options-view',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'options-title',
  });
  root.hidden = true;

  const close = el('button', {
    type: 'button',
    class: 'overlay-close',
    'aria-label': 'Return to Atlas',
    text: 'Return  O',
  });
  close.addEventListener('click', callbacks.onClose);

  const contrast = el('select', { 'aria-label': 'Contrast' }, [
    option('standard', 'Standard'),
    option('high', 'High'),
  ]);
  const transparency = el('select', { 'aria-label': 'Transparency' }, [
    option('layered', 'Layered'),
    option('reduced', 'Reduced'),
  ]);
  const fieldOfView = el('input', {
    type: 'range', min: '60', max: '90', step: '1', 'aria-label': 'Field of view',
  });
  const fieldOfViewValue = el('output', { class: 'option-value' });
  const sensitivity = el('input', {
    type: 'range', min: '0.5', max: '2', step: '0.1', 'aria-label': 'Look sensitivity',
  });
  const sensitivityValue = el('output', { class: 'option-value' });
  const vignette = el('select', { 'aria-label': 'Comfort vignette' }, [
    option('off', 'Off'),
    option('subtle', 'Subtle'),
    option('strong', 'Strong'),
  ]);
  const companionSide = el('select', { 'aria-label': 'Companion side' }, [
    option('right', 'Right'),
    option('left', 'Left'),
  ]);

  const activeStyle = worldArtProfile(callbacks.preferences.worldArtProfile);
  const styleControls = worldStyleControls(activeStyle.profileId);
  const styleInputs = new Map<string, {
    readonly definition: WorldStyleParameterDefinition;
    readonly input: HTMLInputElement | HTMLSelectElement;
    readonly output?: HTMLOutputElement;
  }>();
  const styleFields = styleControls.map((definition) => {
    let input: HTMLInputElement | HTMLSelectElement;
    let output: HTMLOutputElement | undefined;
    if (definition.kind === 'range') {
      input = el('input', {
        type: 'range', min: String(definition.min), max: String(definition.max),
        step: String(definition.step), 'aria-label': definition.label,
      });
      output = el('output', { class: 'option-value' });
    } else if (definition.kind === 'choice') {
      input = el('select', { 'aria-label': definition.label },
        definition.options.map((item) => option(item.value, item.label)));
    } else {
      input = el('input', {
        type: definition.kind === 'color' ? 'color' : 'checkbox',
        'aria-label': definition.label,
      });
    }
    styleInputs.set(definition.key, { definition, input, ...(output === undefined ? {} : { output }) });
    const control = output === undefined
      ? input
      : el('span', { class: 'range-control' }, [input, output]);
    return field(definition.label, control, definition.description);
  });

  let current = callbacks.preferences;
  const commit = (patch: Partial<AtlasPreferences>): void => {
    current = normalisePreferences({ ...current, ...patch });
    render();
    callbacks.onChange(current);
  };
  const preview = (patch: Partial<AtlasPreferences>): void => {
    current = normalisePreferences({ ...current, ...patch });
    render();
    callbacks.onPreview?.(current);
  };
  const render = (): void => {
    contrast.value = current.contrast;
    transparency.value = current.transparency;
    fieldOfView.value = String(current.fieldOfView);
    fieldOfViewValue.value = `${current.fieldOfView}°`;
    sensitivity.value = String(current.mouseSensitivity);
    sensitivityValue.value = `${current.mouseSensitivity.toFixed(1)}×`;
    vignette.value = current.vignette;
    companionSide.value = current.companionSide;
    for (const { definition, input, output } of styleInputs.values()) {
      const value = current.worldStyleParameters[definition.key] ?? definition.defaultValue;
      if (definition.kind === 'toggle') (input as HTMLInputElement).checked = value === true;
      else input.value = String(value);
      if (output !== undefined && definition.kind === 'range' && typeof value === 'number') {
        output.value = definition.min === 0 && definition.max === 1
          ? `${Math.round(value * 100)}%`
          : String(value);
      }
    }
  };

  contrast.addEventListener('change', () =>
    commit({ contrast: contrast.value as ContrastPreference }));
  transparency.addEventListener('change', () =>
    commit({ transparency: transparency.value as TransparencyPreference }));
  fieldOfView.addEventListener('input', () => commit({ fieldOfView: fieldOfView.valueAsNumber }));
  sensitivity.addEventListener('input', () =>
    commit({ mouseSensitivity: sensitivity.valueAsNumber }));
  vignette.addEventListener('change', () =>
    commit({ vignette: vignette.value as VignettePreference }));
  companionSide.addEventListener('change', () =>
    commit({ companionSide: companionSide.value === 'left' ? 'left' : 'right' }));
  for (const [key, { definition, input }] of styleInputs) {
    const stylePatch = (): Partial<AtlasPreferences> => {
      const value: WorldStyleParameterValue = definition.kind === 'range'
        ? (input as HTMLInputElement).valueAsNumber
        : definition.kind === 'toggle'
          ? (input as HTMLInputElement).checked
          : input.value;
      return { worldStyleParameters: { ...current.worldStyleParameters, [key]: value } };
    };
    if (definition.kind === 'range' || definition.kind === 'color') {
      input.addEventListener('input', () => preview(stylePatch()));
      input.addEventListener('change', () => callbacks.onChange(current));
    } else {
      input.addEventListener('change', () => commit(stylePatch()));
    }
  }

  const controls = el('button', { type: 'button', class: 'text-action', text: 'View controls  ?' });
  controls.addEventListener('click', callbacks.onShowControls);
  const reset = el('button', { type: 'button', class: 'text-action', text: 'Restore defaults' });
  reset.addEventListener('click', () => commit(DEFAULT_PREFERENCES));

  root.append(
    el('header', { class: 'overlay-head' }, [
      el('div', {}, [
        el('p', { class: 'overlay-kicker', text: 'Atlas system' }),
        el('h1', { id: 'options-title', text: 'Options' }),
      ]),
      close,
    ]),
    el('div', { class: 'option-group appearance-options' }, [
      el('h2', { text: 'Display' }),
      field('Contrast', contrast, 'Strengthens edges and reading surfaces without changing evidence colors.'),
      field('Transparency', transparency, 'Reduced removes glass and grain beneath reading surfaces.'),
    ]),
    el('div', { class: 'option-group world-style-options' }, [
      el('div', { class: 'world-style-head' }, [
        el('h2', { text: 'World design' }),
        el('strong', { class: 'world-style-name', text: activeStyle.displayName }),
        el('p', { class: 'option-note', text: activeStyle.description }),
      ]),
      ...styleFields,
    ]),
    el('div', { class: 'option-group view-options' }, [
      el('h2', { text: 'View' }),
      field('Field of view', el('span', { class: 'range-control' }, [fieldOfView, fieldOfViewValue])),
      field('Look sensitivity', el('span', { class: 'range-control' }, [sensitivity, sensitivityValue])),
      field('Comfort vignette', vignette, 'Darkens the periphery while traversing; it does not hide evidence.'),
    ]),
    el('div', { class: 'option-group companion-options' }, [
      el('h2', { text: 'Companion' }),
      field('Screen side', companionSide),
    ]),
    el('footer', { class: 'overlay-actions' }, [controls, reset]),
  );
  render();

  const modalFocus = createModalFocus(root, close);
  return {
    root,
    preferences: () => current,
    setPreferences(value) {
      current = normalisePreferences(value);
      render();
    },
    setVisible(visible) {
      modalFocus.setVisible(visible);
    },
  };
}
