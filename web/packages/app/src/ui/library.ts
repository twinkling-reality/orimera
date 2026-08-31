/**
 * The left rail: what is in this library, and what is not identified yet.
 *
 * Two lists, and the second one is the interesting one. `world-index` models ENTITIES, because
 * the World Index is a list of people, places and things. A library nobody has named yet has no
 * entities at all, and rendering only the index would show an empty product on top of a full
 * one: 312 detections that the user cannot reach.
 *
 * So the second list is bare occurrences, composed here rather than in `world-index`, because an
 * unidentified detection is not an index row and giving it one would be giving an anonymous
 * occurrence the shape of a named thing. id-1: the occurrence is anonymous and the entity holds
 * the name.
 *
 * The empty state of the first list says which zero it is. "Nothing has been identified yet" and
 * "nothing matched your filters" are different facts and only one of them means the library is
 * empty.
 */

import type { GraphSnapshot, OccurrenceRecord } from '@orimera/graph-client';
import type { IndexRow, IndexView } from '@orimera/world-index';
import { buildIndexView } from '@orimera/world-index';
import { say } from './copy.js';
import { el, replace } from './dom.js';

export interface LibraryHandlers {
  onEntity(entityId: string): void;
  onOccurrence(occurrenceId: string): void;
  onSearch(text: string): void;
}

export interface LibraryPane {
  readonly root: HTMLElement;
  render(snapshot: GraphSnapshot, search: string, selected: string | null): void;
}

export interface LibraryPresentation {
  readonly preview?: boolean;
}

/** How many bare detections are listed before the rail stops and says how many are left. */
const DETECTION_PAGE = 60;

export function buildLibrary(
  handlers: LibraryHandlers,
  presentation: LibraryPresentation = {},
): LibraryPane {
  const root = el('nav', { class: 'rail', 'aria-label': 'Library' });

  const search = el('input', {
    type: 'search',
    class: 'rail-search',
    placeholder: 'Search',
    'aria-label': 'Search the library',
  });
  search.addEventListener('input', () => handlers.onSearch(search.value));

  const counter = el('p', { class: 'rail-counter', 'aria-live': 'polite' });
  const identified = el('ul', { class: 'rail-list', 'aria-label': 'Identified' });
  const detections = el('ul', { class: 'rail-list', 'aria-label': 'Unidentified detections' });
  const detectionsNote = el('p', { class: 'rail-note' });

  root.append(
    search,
    counter,
    el('h2', { class: 'rail-head', text: 'Identified' }),
    identified,
    el('h2', { class: 'rail-head', text: 'Not identified' }),
    detectionsNote,
    detections,
  );

  return {
    root,
    render(snapshot, searchText, selected) {
      const view = buildIndexView({ snapshot, search: searchText });
      // A count, and nothing a progress ring can be built from. interaction-model.md 5.5: the
      // counter "is allowed to read 7 forever. THERE IS NO COMPLETION METRIC ANYWHERE."
      counter.textContent = `${view.openQuestions.count} open ${
        view.openQuestions.count === 1 ? 'question' : 'questions'
      }`;

      replace(
        identified,
        view.rows.length > 0
          ? view.rows.map((row) => entityRow(row, row.entityId === selected, handlers))
          : [emptyState(view, snapshot)],
      );

      const bare = snapshot.occurrences.filter((o) => o.entityId === null);
      detectionsNote.textContent =
        bare.length === 0
          ? 'Every detection in this library has been identified.'
          : presentation.preview === true
            ? `${bare.length} synthetic detections nobody has named. Fixture sources remain inspectable; unavailable evidence stays explicit.`
            : `${bare.length} detections nobody has named. Each one opens the photograph it came from.`;
      replace(
        detections,
        bare
          .slice(0, DETECTION_PAGE)
          .map((occurrence) =>
            detectionRow(occurrence, occurrence.occurrenceId === selected, handlers),
          ),
      );
      if (bare.length > DETECTION_PAGE) {
        // Said out loud rather than truncated silently. A list that stops without saying so reads
        // as the whole list.
        detections.append(
          el('li', {
            class: 'rail-more',
            text: `${bare.length - DETECTION_PAGE} more, not listed here.`,
          }),
        );
      }
    },
  };
}

/**
 * An index row.
 *
 * The three-mark provenance triad, the honest placeholder where there is no name, and a
 * confidence bar only for an inferred entity. All three come from `world-index`'s view model
 * rather than being decided here, so the rules hold identically on every surface that renders it.
 */
function entityRow(row: IndexRow, selected: boolean, handlers: LibraryHandlers): HTMLElement {
  const button = el('button', {
    type: 'button',
    class: 'rail-row',
    'aria-current': selected ? 'true' : undefined,
  });
  button.addEventListener('click', () => handlers.onEntity(row.entityId));

  const name =
    row.displayName ??
    // Never written into the same field a real name would occupy. `placeholder` is a separate
    // structure precisely so a name-shaped thing that is not a name cannot be mistaken for one.
    `Unnamed ${row.placeholder?.kind ?? row.kind}, ${row.occurrenceCount} occurrences`;

  button.append(
    el('span', { class: 'rail-kind', text: row.kind }),
    el('span', { class: row.displayName === null ? 'rail-name is-placeholder' : 'rail-name' }, [
      name,
    ]),
    triad(row),
  );
  return el('li', {}, [button]);
}

function triad(row: IndexRow): HTMLElement {
  const marks = el('span', { class: 'triad', 'aria-label': 'What is known, and how' });
  for (const [key, present] of [
    ['user', row.triad.user],
    ['capture', row.triad.capture],
    ['inference', row.triad.inference],
  ] as const) {
    marks.append(
      el('span', {
        class: `mark mark-${key}${present ? '' : ' is-absent'}`,
        title: key,
        text: key[0]?.toUpperCase() ?? '',
      }),
    );
  }
  if (row.external !== null) {
    // epi-2 gives external its own rendering obligation and its own date, which is why it is a
    // separate badge rather than a fourth mark in a triad that is specified as three.
    marks.append(el('span', { class: 'mark mark-external', title: 'external', text: 'E' }));
  }
  return marks;
}

function detectionRow(
  occurrence: OccurrenceRecord,
  selected: boolean,
  handlers: LibraryHandlers,
): HTMLElement {
  const button = el('button', {
    type: 'button',
    class: 'rail-row is-bare',
    'aria-current': selected ? 'true' : undefined,
  });
  button.addEventListener('click', () => handlers.onOccurrence(occurrence.occurrenceId));
  button.append(
    el('span', { class: 'rail-kind', text: occurrence.kind }),
    el('span', { class: 'rail-name is-placeholder', text: whenOf(occurrence) }),
  );
  return el('li', {}, [button]);
}

/**
 * When a detection was captured, or that it is not known.
 *
 * A photograph with no usable clock is a real and common state, and the honest rendering of it is
 * a sentence saying so rather than a blank cell that reads as a rendering bug.
 */
function whenOf(occurrence: OccurrenceRecord): string {
  if (occurrence.capturedAtMs === null) return 'time not recorded';
  return new Date(occurrence.capturedAtMs).toISOString().slice(0, 16).replace('T', ' ');
}

/** Which zero this is. The two are different facts and only one means the library is empty. */
function emptyState(view: IndexView, snapshot: GraphSnapshot): HTMLElement {
  const nothingIdentified = snapshot.entities.length === 0;
  return el('li', { class: 'rail-empty' }, [
    nothingIdentified
      ? 'Nobody and nothing has been identified yet. Every detection below is anonymous until you say what it is.'
      : say(view.emptyStateKey ?? 'index.noMatches'),
  ]);
}
