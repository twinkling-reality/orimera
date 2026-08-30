import { el } from './dom.js';

export type AtlasCommand = 'index' | 'map' | 'options' | 'controls';

export interface AtlasCommands {
  readonly root: HTMLElement;
  reflect(primary: string, camera: string): void;
}

export function buildAtlasCommands(onCommand: (command: AtlasCommand) => void): AtlasCommands {
  const entries: readonly (readonly [AtlasCommand, string, string])[] = [
    ['index', 'Index', 'I'],
    ['map', 'Map', 'M'],
    ['options', 'Options', 'O'],
    ['controls', 'Controls', '?'],
  ];
  const buttons = new Map<AtlasCommand, HTMLButtonElement>();
  const root = el('nav', { class: 'atlas-commands', 'aria-label': 'Atlas commands' });
  for (const [command, label, key] of entries) {
    const button = el('button', { type: 'button', 'data-command': command }, [
      el('span', { text: label }),
      el('kbd', { text: key }),
    ]);
    button.addEventListener('click', () => onCommand(command));
    buttons.set(command, button);
    root.append(button);
  }
  return {
    root,
    reflect(primary, camera) {
      for (const [command, button] of buttons) {
        const current =
          (command === 'index' && primary === 'index') ||
          (command === 'map' && camera === 'map') ||
          (command === 'options' && primary === 'options') ||
          (command === 'controls' && primary === 'controls');
        if (current) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    },
  };
}
