import type { Turn, TurnOption } from '@exulanica/companion-runtime';
import { buildCompanionComposer, type CompanionComposer } from './companion-composer.js';
import { commandAction, el, replace } from './dom.js';
import { say } from './copy.js';

export interface CompanionChoiceHandlers {
  readonly onSelect: (optionId: string) => void;
  readonly onSubmit: (optionIds: readonly string[]) => void;
  readonly onSay: (text: string) => void;
  /** Open the exact photograph the current turn cites. */
  readonly onEvidence: (handleIndex: number) => void;
}

export interface CompanionChoiceRail {
  readonly root: HTMLElement;
  render(turn: Turn): void;
  pressNumber(index: number): boolean;
  /** Whether the current turn cites anything, so `E` knows if it has a job. */
  openEvidence(): boolean;
}

function optionLabel(option: TurnOption): string {
  return option.phrasing ?? say(option.textKey);
}

function singleChoice(
  option: TurnOption,
  index: number | null,
  onSelect: (optionId: string) => void,
): HTMLElement {
  const button = el('button', {
    type: 'button',
    class: option.tier >= 2 ? 'companion-choice consequential' : 'companion-choice',
  });
  // `commandAction` is the one command-key element in the workspace. A choice is a keyed action
  // like every other keyed action, so it uses that rather than a second bespoke cap.
  if (index !== null) button.append(...commandAction(String(index), optionLabel(option)));
  else button.append(el('span', { class: 'command-action-label', text: optionLabel(option) }));
  if (option.available) button.addEventListener('click', () => onSelect(option.optionId));
  else {
    button.setAttribute('disabled', '');
    button.setAttribute('aria-disabled', 'true');
  }

  const children: (Node | string)[] = [button];
  if (!option.available) {
    children.push(el('span', {
      class: 'choice-unavailable-reason',
      text: option.unavailableReasonKey === null ? '' : say(option.unavailableReasonKey),
    }));
  }
  return el('li', { class: option.available ? 'choice-item' : 'choice-item unavailable' }, children);
}

export function buildCompanionChoiceRail(
  handlers: CompanionChoiceHandlers,
): CompanionChoiceRail {
  const root = el('section', {
    class: 'companion-choice-rail',
    'aria-label': 'Response choices',
  });
  let lastTurn: Turn | null = null;
  let composer: CompanionComposer | null = null;

  function render(turn: Turn): void {
    lastTurn = turn;
    composer = null;
    const content: (Node | string)[] = [];
    const choice = turn.choiceSet;
    const list = el('ol', { class: 'companion-choices' });

    if (choice?.mode === 'single') {
      list.append(...choice.options.map((option, index) =>
        singleChoice(option, index + 1, handlers.onSelect)));
    } else if (choice !== null) {
      const checks: HTMLInputElement[] = [];
      for (const [index, option] of choice.options.entries()) {
        const box = el('input', {
          type: 'checkbox',
          value: option.optionId,
          class: 'choice-checkbox',
        });
        if (!option.available) box.setAttribute('disabled', '');
        checks.push(box);
        const label = el('label', { class: 'companion-choice multi-choice' }, [
          box,
          el('b', { class: 'choice-key', text: String(index + 1) }),
          el('span', { class: 'choice-label', text: optionLabel(option) }),
        ]);
        const itemContent: (Node | string)[] = [label];
        if (!option.available) {
          itemContent.push(el('span', {
            class: 'choice-unavailable-reason',
            text: option.unavailableReasonKey === null ? '' : say(option.unavailableReasonKey),
          }));
        }
        list.append(el(
          'li',
          { class: option.available ? 'choice-item' : 'choice-item unavailable' },
          itemContent,
        ));
      }
      const submit = el('button', {
        type: 'button',
        class: 'companion-choices-submit',
        text: 'Submit selected',
      });
      submit.addEventListener('click', () => {
        handlers.onSubmit(checks.filter((check) => check.checked).map((check) => check.value));
      });
      content.push(submit);
    }

    if (turn.freeTextAllowed) {
      composer = buildCompanionComposer(handlers.onSay);
      const otherIndex = (choice?.options.length ?? 0) + 1;
      const other = el('button', {
        type: 'button',
        class: 'companion-choice companion-other-reveal',
        'aria-expanded': 'false',
      }, [
        el('b', { class: 'choice-key', text: String(otherIndex) }),
        el('span', { class: 'choice-label', text: 'Other…' }),
      ]);
      other.replaceChildren(...commandAction(String(otherIndex), 'Other…'));
      const otherItem = el('li', { class: 'choice-item companion-other' }, [other, composer.root]);
      other.addEventListener('click', () => {
        const opening = !composer?.opened();
        if (opening) composer?.open();
        else composer?.close();
        other.setAttribute('aria-expanded', String(opening));
        other.toggleAttribute('hidden', opening);
      });
      list.append(otherItem);
    }

    if (list.childElementCount > 0) content.unshift(list);

    const visibleEscapes = turn.escapes.filter((option) => option.escape !== 'later');
    if (visibleEscapes.length > 0) {
      content.push(el(
        'ul',
        { class: 'companion-escapes', 'aria-label': 'Other responses' },
        visibleEscapes.map((option) => singleChoice(option, null, handlers.onSelect)),
      ));
    }

    /*
     * The citation, on a key, at the foot of the panel where the actions are.
     *
     * It used to be a control inside the sentence the Companion had just spoken, which put an
     * action in the one region reserved for speech. It matters too much to simply delete: seeing
     * the exact photograph is how a person answers the question being asked. So it lives with the
     * other things you can press, on `E`, which is already the Atlas verb for "interact with what
     * is in front of you".
     */
    if (turn.evidence.length > 0) {
      const open = el('button', {
        type: 'button',
        class: 'companion-choice companion-evidence-action',
      }, commandAction('E', turn.evidence.length === 1 ? 'Open the source' : 'Open the sources'));
      open.addEventListener('click', () => handlers.onEvidence(0));
      content.push(el('div', { class: 'companion-rail-foot' }, [open]));
    }

    replace(root, content);
  }

  return {
    root,
    render,
    openEvidence() {
      const action = root.querySelector<HTMLButtonElement>('.companion-evidence-action');
      if (action === null) return false;
      action.click();
      return true;
    },
    pressNumber(index) {
      const choice = lastTurn?.choiceSet ?? null;
      if (lastTurn === null) return false;
      const option = choice?.options[index - 1];
      if (option === undefined) {
        const otherIndex = (choice?.options.length ?? 0) + 1;
        if (!lastTurn.freeTextAllowed || index !== otherIndex) return false;
        root.querySelector<HTMLButtonElement>('.companion-other-reveal:not([hidden])')?.click();
        return true;
      }
      if (!option.available) return false;
      if (choice?.mode === 'single') {
        handlers.onSelect(option.optionId);
        return true;
      }
      const box = root.querySelector<HTMLInputElement>(
        `.choice-checkbox[value="${option.optionId}"]`,
      );
      if (box === null) return false;
      box.checked = !box.checked;
      return true;
    },
  };
}
