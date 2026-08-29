import type { Turn, TurnOption } from '@orimera/companion-runtime';
import { el, replace } from './dom.js';
import { say } from './copy.js';

/**
 * The Companion's dialogue panel.
 *
 * **The panel is screen space and stays put while you read it.** A bubble following a body around
 * the world would force the user to keep that body in frame, would be occluded by geometry, and
 * could not hold evidence chips or a multi-select. Anchored at the foot of the screen, the user
 * can read the question while looking at whatever it is about.
 *
 * **Unavailable options are delivered, not hidden.** That is Yarn Spinner's availability
 * semantics, adopted deliberately: an option that silently vanishes teaches the user nothing,
 * while one shown with its reason teaches them what the system needs. The reason is rendered
 * beside the option and the control is genuinely disabled.
 *
 * **Escape is not bound here and must never be.** It has exactly one meaning everywhere in
 * Orimera, which is release the mouse, and that is why this is an `aside` and not a `<dialog>`:
 * a dialog takes Escape for free and would quietly steal it.
 */

export interface CompanionHandlers {
  /** Send it away. Always available: a conversation with no way out is a trap, not a turn. */
  onDismiss(): void;
  onSelect(optionId: string): void;
  onSubmit(optionIds: readonly string[]): void;
  onSay(text: string): void;
  onEvidence(handleIndex: number): void;
}

/**
 * Three states, one element.
 *
 * `enter` is shown with the mouse free and says how to get into the world. `summon` is the resting
 * prompt. `open` is the turn. They are one element rather than three because the transition
 * between them is the point: the prompt expands into the conversation it promised, which is the
 * grammar a game uses, and it is why none of this has to stand permanently on screen.
 */
export type PanelState = 'enter' | 'summon' | 'open';

export interface CompanionPanel {
  readonly root: HTMLElement;
  /** Which of the three the panel is showing. `open` needs a turn to have been rendered. */
  setState(state: PanelState): void;
  state(): PanelState;
  render(turn: Turn | null): void;
  /** Report a refusal in the words the refusal used. Never invents a reason. */
  reportRefusal(reasonKey: string): void;
  /**
   * Handle a number key. True when it did something.
   *
   * The panel decides what a number MEANS, because that depends on the choice mode and the mode
   * is a property of the turn: in a single select the number is the answer and commits, in a
   * multi select it ticks a box and the user still has to submit. A caller that mapped keys
   * itself would have to know that distinction, and would eventually commit a multi-select option
   * on a keystroke.
   */
  pressNumber(index: number): boolean;
  hide(): void;
}

function optionButton(
  option: TurnOption,
  onPick: (id: string) => void,
  index: number | null,
): HTMLElement {
  const label = option.phrasing ?? say(option.textKey);
  const button = el('button', {
    type: 'button',
    class: option.tier >= 2 ? 'option consequential' : 'option',
  });
  // Numbered, and the number is the whole point rather than decoration: while the pointer is
  // locked for movement there is nothing to click with, so a key is the only way to answer
  // without leaving the world. Escapes are unnumbered because they are not answers.
  if (index !== null) button.append(el('b', { class: 'key', text: String(index) }));
  button.append(label);
  if (!option.available) {
    button.setAttribute('disabled', '');
    button.setAttribute('aria-disabled', 'true');
  } else {
    button.addEventListener('click', () => onPick(option.optionId));
  }

  if (option.available) return el('li', {}, [button]);

  // Delivered with its reason rather than removed. A missing option is indistinguishable from a
  // system that never considered it.
  const why = el('span', {
    class: 'why',
    text: option.unavailableReasonKey === null ? '' : say(option.unavailableReasonKey),
  });
  return el('li', { class: 'unavailable' }, [button, why]);
}

export function buildCompanionPanel(handlers: CompanionHandlers): CompanionPanel {
  const root = el('aside', {
    class: 'companion-panel',
    'aria-label': 'Companion',
    'aria-live': 'polite',
    'data-state': 'enter',
  });
  let state: PanelState = 'enter';
  let lastTurn: Turn | null = null;

  function renderPrompt(): void {
    replace(root, [
      el(
        'p',
        { class: 'prompt' },
        state === 'enter'
          ? ['Click to look around']
          : ['Press ', el('b', { text: 'X' }), ' to summon the Companion'],
      ),
    ]);
  }

  function renderTurn(turn: Turn): void {

      const children: (Node | string)[] = [];

      // A way out that is not an escape. The four escapes are answers about the question; this
      // just puts the Companion away, and it carries the key so the keyboard route is learnable
      // rather than hidden. Escape is deliberately not it: that releases the mouse and nothing
      // else, everywhere in the product.
      const close = el('button', {
        type: 'button',
        class: 'panel-close',
        'aria-label': 'Dismiss the Companion',
        text: 'X',
      });
      close.addEventListener('click', () => handlers.onDismiss());
      children.push(close);

      // Named, the way a game names whoever is talking. The label is the Companion's own name for
      // its own words. It says nothing about audio: the product has none, and nothing here is
      // derived from a recording.
      children.push(
        el('p', { class: 'utterance' }, [
          el('span', { class: 'speaker', text: 'Wayfinder' }),
          turn.utterance ?? say(turn.utteranceKey),
        ]),
      );

      if (turn.evidence.length > 0) {
        const chips = turn.evidence.map((_, i) => {
          const chip = el('button', { type: 'button', class: 'evidence-chip', text: `source ${i + 1}` });
          chip.addEventListener('click', () => handlers.onEvidence(i));
          return el('li', {}, [chip]);
        });
        children.push(el('ul', { class: 'evidence' }, chips));
      }

      const choice = turn.choiceSet;
      if (choice !== null && choice.mode === 'single') {
        // Single select commits on click. 4.3 reserves this for answers that are logically
        // exclusive or that carry a consequence, where a second confirming click would be noise
        // in front of the confirmation surface that is about to open anyway.
        children.push(
          el(
            'ul',
            { class: 'options' },
            choice.options.map((o, i) => optionButton(o, handlers.onSelect, i + 1)),
          ),
        );
      } else if (choice !== null) {
        const checks: HTMLInputElement[] = [];
        const items = choice.options.map((o, i) => {
          const box = el('input', { type: 'checkbox', value: o.optionId });
          if (!o.available) box.setAttribute('disabled', '');
          checks.push(box as HTMLInputElement);
          // Numbered here as well as in single select. The key ticks rather than commits, which
          // is the difference the panel owns and the caller must not have to know.
          const label = el('label', {}, [
            box,
            el('b', { class: 'key', text: String(i + 1) }),
            o.phrasing ?? say(o.textKey),
          ]);
          return el('li', o.available ? {} : { class: 'unavailable' }, [label]);
        });
        const submit = el('button', { type: 'button', class: 'primary', text: 'Submit' });
        submit.addEventListener('click', () => {
          handlers.onSubmit(checks.filter((c) => c.checked).map((c) => c.value));
        });
        children.push(el('ul', { class: 'options multi' }, items));
        children.push(submit);
      }

      if (turn.freeTextAllowed) {
        const input = el('input', { type: 'text', class: 'free', 'aria-label': 'Answer in your own words' });
        const send = el('button', { type: 'button', class: 'ghost', text: 'Send' });
        const submitText = (): void => {
          const value = (input as HTMLInputElement).value.trim();
          if (value !== '') handlers.onSay(value);
          (input as HTMLInputElement).value = '';
        };
        send.addEventListener('click', submitText);
        input.addEventListener('keydown', (event) => {
          // Enter only. Escape is deliberately not handled: it releases the mouse and nothing else.
          if ((event as KeyboardEvent).key === 'Enter') submitText();
        });
        children.push(el('div', { class: 'free-row' }, [input, send]));
      }

      // Always present and never penalised. The fourth one is the load-bearing one: without it a
      // user whose situation has been mis-modelled can only keep skipping, and skip is
      // indistinguishable from disinterest.
      children.push(
        el(
          'ul',
          { class: 'escapes' },
          turn.escapes.map((o) => optionButton(o, handlers.onSelect, null)),
        ),
      );

    replace(root, children);
  }

  renderPrompt();

  return {
    root,
    state: () => state,

    setState(next) {
      state = next;
      root.setAttribute('data-state', next);
      if (next === 'open' && lastTurn !== null) {
        renderTurn(lastTurn);
        return;
      }
      renderPrompt();
    },

    render(turn) {
      lastTurn = turn;
      if (turn === null || state !== 'open') {
        renderPrompt();
        return;
      }
      renderTurn(turn);
    },

    pressNumber(index) {
      const choice = lastTurn?.choiceSet ?? null;
      if (choice === null || state !== 'open') return false;
      const option = choice.options[index - 1];
      // An unavailable option's key does nothing, rather than falling through to the next
      // available one. A key that silently selected something adjacent would commit a claim
      // about a person that nobody chose.
      if (option === undefined || !option.available) return false;

      if (choice.mode === 'single') {
        handlers.onSelect(option.optionId);
        return true;
      }
      const box = root.querySelector<HTMLInputElement>(
        `.options input[type=checkbox][value="${option.optionId}"]`,
      );
      if (box === null) return false;
      box.checked = !box.checked;
      return true;
    },

    reportRefusal(reasonKey) {
      const note = el('p', { class: 'refusal', text: say(reasonKey) });
      root.append(note);
    },

    hide() {
      root.setAttribute('hidden', '');
    },
  };
}
