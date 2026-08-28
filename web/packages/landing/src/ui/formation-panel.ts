/**
 * The formation console: the label half of "processing is shown as spatial formation".
 *
 * The particle field carries the visual state and this panel carries the factual one, and
 * interaction-model.md 8.1 requires them to be paired: "Every visual formation state is paired
 * with a factual label naming the real pipeline stage and the real unit of progress."
 *
 * Three things this panel deliberately does not have:
 *
 *   - A percentage. The meter is rendered only when a real fraction exists, and even then its
 *     accessible name is the raw pair of counts. A percentage implies a precision the pipeline
 *     did not report.
 *   - An estimated time remaining. Nothing in the event stream carries one.
 *   - A completion state. `ready` with seven open questions is a normal, permanent, non-failing
 *     state, and the panel never congratulates anybody for reaching it.
 */

import {
  FORMATION_STAGES,
  MOCK_BANNER,
  MOCK_SCENARIOS,
  STAGE_NAME,
  formationLabel,
  isOutcome,
  phaseIndex,
  progressFraction,
  type FormationStage,
  type FormationState,
  type MockScenario,
} from '../formation/index.js';
import { el } from './dom.js';

export interface FormationPanelHandles {
  readonly root: HTMLElement;
  /** `null` means no capture is forming. The panel says so rather than showing stage zero. */
  render(state: FormationState | null): void;
}

export function buildFormationPanel(onScenario: (s: MockScenario) => void): FormationPanelHandles {
  const root = el('section', { class: 'console', 'aria-labelledby': 'formation-heading' });

  // The mock banner is mounted unconditionally alongside the mock source and is not dismissible.
  // product-specification.md 4.1 lists "a progress bar not driven by real job state" as
  // explicitly unacceptable demo behaviour; the counts below are scripted, so the page says so.
  root.append(el('p', { class: 'mock-banner', text: MOCK_BANNER }));
  root.append(el('h2', { id: 'formation-heading', class: 'console-heading', text: 'A capture forming' }));

  const track = el('ol', { class: 'track' });
  const trackItems = new Map<FormationStage, HTMLElement>();
  for (const stage of FORMATION_STAGES) {
    const li = el('li', { class: 'track-step' }, [
      el('span', { class: 'track-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'track-name', text: STAGE_NAME[stage] }),
    ]);
    trackItems.set(stage, li);
    track.append(li);
  }
  const outcomeItem = el('li', { class: 'track-step track-outcome' }, [
    el('span', { class: 'track-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'track-name', text: 'Outcome' }),
  ]);
  track.append(outcomeItem);
  root.append(track);

  const stageName = el('p', { class: 'stage-name' });
  const headline = el('p', { class: 'headline' });
  const detail = el('ul', { class: 'detail' });
  const elapsed = el('p', { class: 'elapsed' });
  const note = el('p', { class: 'note' });
  const meterWrap = el('div', { class: 'meter' }, [el('span', { class: 'meter-fill' })]);
  const meterFill = meterWrap.firstElementChild as HTMLElement;

  // Polite, not assertive: formation is ambient. It must never interrupt a screen reader user
  // mid-sentence, which is the same rule the Companion's initiative gate follows.
  const idle = el('p', {
    class: 'idle',
    text:
      'Nothing is forming. This Atlas is empty because nothing has been uploaded to it. Replay a scripted formation below to see the states a capture passes through.',
  });

  const live = el('div', { class: 'label', 'aria-live': 'polite' }, [
    idle,
    stageName,
    headline,
    detail,
    meterWrap,
    elapsed,
    note,
  ]);
  root.append(live);

  const controls = el('div', { class: 'scenarios' }, [
    el('p', { class: 'scenarios-head', text: 'Replay a scripted outcome' }),
  ]);
  const group = el('div', { class: 'scenario-group', role: 'group', 'aria-label': 'Scripted outcomes' });
  for (const s of MOCK_SCENARIOS) {
    const b = el('button', { type: 'button', class: 'scenario', 'data-scenario': s, text: SCENARIO_LABEL[s] });
    b.addEventListener('click', () => onScenario(s));
    group.append(b);
  }
  controls.append(group);
  root.append(controls);

  function render(state: FormationState | null): void {
    // Idle is a real state and it is displayed as one. Rendering the reducer's initial value
    // instead would print "Photographs received. Not yet counted." about an upload that never
    // happened, which is the exact class of claim this panel exists to prevent.
    idle.hidden = state !== null;
    track.hidden = state === null;
    for (const node of [stageName, headline, detail, elapsed, note, meterWrap]) node.hidden = state === null;
    if (state === null) {
      delete root.dataset['stream'];
      delete root.dataset['phase'];
      return;
    }

    const label = formationLabel(state);
    const current = phaseIndex(state.phase);

    for (const [stage, li] of trackItems) {
      const idx = phaseIndex(stage);
      li.className =
        idx < current ? 'track-step is-passed' : idx === current ? 'track-step is-current' : 'track-step';
    }
    outcomeItem.className = isOutcome(state.phase)
      ? `track-step track-outcome is-current is-${state.phase}`
      : 'track-step track-outcome';

    stageName.textContent = label.stage;
    headline.textContent = label.headline;

    detail.replaceChildren(...label.detail.map((d) => el('li', { text: d })));
    detail.hidden = label.detail.length === 0;

    elapsed.textContent = label.elapsed ?? '';
    elapsed.hidden = label.elapsed === null;

    note.textContent = label.note === null ? '' : `From the pipeline: ${label.note}`;
    note.hidden = label.note === null;

    const fraction = progressFraction(state);
    const counters = state.counters;
    if (fraction === null || counters === null || counters.total === null) {
      // No fraction, no meter. Not an empty meter, not a meter at zero, not an indeterminate
      // barber pole: the absence of the control is the honest rendering of an absent number.
      meterWrap.hidden = true;
    } else {
      meterWrap.hidden = false;
      meterFill.style.width = `${(fraction * 100).toFixed(2)}%`;
      meterWrap.setAttribute('role', 'img');
      meterWrap.setAttribute('aria-label', `${counters.done} of ${counters.total}`);
    }

    root.dataset['stream'] = state.stream;
    root.dataset['phase'] = state.phase;
  }

  return { root, render };
}

const SCENARIO_LABEL: Readonly<Record<MockScenario, string>> = Object.freeze({
  ready: 'Ready',
  review_required: 'Review required',
  partial: 'Partial',
  failed: 'Failed',
  stream_loss: 'Stream lost',
});
