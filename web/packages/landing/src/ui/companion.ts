/**
 * The Companion, as a panel, on the signed-out surface.
 *
 * WHY THIS TURN IS DEFINED HERE AND NOT TAKEN FROM `@orimera/companion-runtime`.
 *
 * That package generates turns from the entity graph: an option carries a `ProposalDraft` and a
 * `ConsequenceTier` because it is about to write something about a real person in a real capture.
 * On a signed-out page there is no graph, no capture and nothing to write, so there is no turn for
 * it to generate. This is the one turn that precedes the data, which is exactly why the engine
 * cannot produce it. It is not a copy of the engine; it is the thing that runs before the engine
 * has anything to work with.
 *
 * It also keeps the boundary honest. `.dependency-cruiser.cjs` names `app` as the composition root
 * that may reach the Companion runtime, and the runtime's turn types reach into `graph-client`.
 * Pulling both into the signed-out surface to hard-code one greeting would be paying an
 * architectural price for a convenience.
 *
 * WHAT IS BORROWED, DELIBERATELY: the shape. An utterance, a choice set, options that carry a
 * stable id and a human line, and a dismissal that costs nothing. When the Companion lands in
 * `app` this panel binds to a real `Turn` and the local turn below is deleted.
 *
 * NO 3D PRESENCE, AND THAT IS SANCTIONED RATHER THAN MISSING. interaction-model.md 4.2: "If no
 * candidate survives, the Companion does not appear in 3D at all: the panel opens alone and the
 * tether terminates in a small edge glyph. Honest degradation rather than a bad placement." There
 * is no world here to place it in, so no candidate survives, so the panel opens alone.
 */

import { el } from './dom.js';

export interface CompanionOption {
  readonly id: string;
  readonly line: string;
  /**
   * A dismissal rather than a choice.
   *
   * This is the `later` escape from interaction-model.md 4.3, whose recorded effect is "the
   * conversation is dismissed, no penalty". The other three escapes are absent on purpose: "Not
   * sure", "Skip" and "That is the wrong question" all encode a judgement about a proposition
   * concerning the user's own memories, and this turn contains no such proposition. Offering them
   * here would be furniture.
   */
  readonly dismiss?: boolean;
}

export interface CompanionTurn {
  readonly utterance: string;
  readonly options: readonly CompanionOption[];
}

export interface CompanionHandles {
  readonly root: HTMLElement;
  /** Show a turn. Passing `null` closes the panel and leaves the summon affordance behind. */
  speak(turn: CompanionTurn | null): void;
}

export function buildCompanion(onSelect: (optionId: string) => void): CompanionHandles {
  const root = el('aside', {
    class: 'companion',
    'aria-label': 'Companion',
    hidden: '',
  });

  const utterance = el('p', { class: 'companion-line' });
  const options = el('div', { class: 'companion-options' });

  /*
   * A dismissed Companion leaves something behind to bring it back.
   *
   * "Later" closes the thread with no penalty, which means it must also be reversible without
   * one. A dismissal that could not be undone would make the offer a trap: the visitor who wanted
   * a moment to read the page first would have thrown the sample away for the session.
   */
  const summon = el('button', {
    type: 'button',
    class: 'companion-summon',
    id: 'path-companion',
  }, ['Ask the Companion']);
  summon.hidden = true;

  const body = el('div', { class: 'companion-body' }, [utterance, options]);
  root.append(body, summon);

  let current: CompanionTurn | null = null;

  function render(): void {
    options.replaceChildren();
    if (current === null) {
      root.hidden = false;
      body.hidden = true;
      summon.hidden = false;
      return;
    }
    root.hidden = false;
    body.hidden = false;
    summon.hidden = true;
    utterance.textContent = current.utterance;
    for (const o of current.options) {
      const b = el('button', {
        type: 'button',
        class: o.dismiss === true ? 'companion-option companion-option-quiet' : 'companion-option',
        id: `companion-${o.id}`,
      }, [o.line]);
      b.addEventListener('click', () => onSelect(o.id));
      options.append(b);
    }
  }

  summon.addEventListener('click', () => onSelect('summon'));

  return {
    root,
    speak(turn) {
      current = turn;
      render();
    },
  };
}

/**
 * The first-run offer.
 *
 * It states the true reason the Atlas is empty before it offers anything, because the empty state
 * is not a failure to explain away. Nothing has been uploaded; that is the whole of it.
 *
 * The offer says "sample regions", not "sample world". They are placed in THIS Atlas, alongside
 * anything the visitor might add later, because interaction-model.md 1.1 has exactly one scene for
 * the whole session and adding a region is a recomposition rather than a rebuild. A separate
 * sample world would be the second scene that decision exists to forbid.
 */
export const FIRST_RUN_OFFER: CompanionTurn = Object.freeze({
  utterance:
    'This Atlas is empty because nothing has been uploaded to it. I can place a few sample regions here so there is something to walk through. They are pre-ingested, and every one of them will say so.',
  options: Object.freeze([
    { id: 'place-sample', line: 'Place the sample regions' },
    { id: 'later', line: 'Not now', dismiss: true },
  ]),
});

/** After the offer is taken. States what was added and, more importantly, what it is not. */
export const SAMPLE_PLACED: CompanionTurn = Object.freeze({
  utterance:
    'Placed. These regions were processed earlier, not just now, and the counts you see in them are scripted rather than measured. Nothing here was reconstructed from anything of yours.',
  options: Object.freeze([{ id: 'later', line: 'Understood', dismiss: true }]),
});
