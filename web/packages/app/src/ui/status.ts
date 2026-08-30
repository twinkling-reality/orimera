/**
 * The permanent Atlas disclosure.
 *
 * The standing caption is never dismissible. It is the user-facing half of the coordinate rule:
 * a region's position in the Atlas carries no real-world meaning, so the interface says that
 * plainly. When part of the world cannot be shown, this bar also names the omission without
 * exposing internal diagnostics.
 */

import type { OccurrenceKind } from '@orimera/graph-client';
import { el } from './dom.js';

/** Fixed by interaction-model.md 6.2. Exported so a test can assert it survives a redesign. */
export const STANDING_CAPTION =
  'Positions show how these memories relate, not where they happened.';
export const PREVIEW_CAPTION =
  'Development preview · synthetic data · read-only · evidence unavailable';

export interface StatusInput {
  readonly omittedRegionCount: number;
  readonly undrawable: ReadonlyMap<OccurrenceKind, number>;
  readonly preview?: boolean;
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function buildStatus(input: StatusInput): HTMLElement {
  const context = el('div', { class: 'status-context' });
  if (input.preview === true) {
    context.append(el('p', { class: 'preview-disclosure', text: PREVIEW_CAPTION }));
  }
  context.append(el('p', { class: 'standing-caption', text: STANDING_CAPTION }));
  const bar = el('footer', { class: 'status' }, [context]);

  const undrawableCount = [...input.undrawable.values()].reduce(
    (total, count) => total + count,
    0,
  );
  const missing: string[] = [];

  if (input.omittedRegionCount > 0) {
    missing.push(counted(input.omittedRegionCount, 'region', 'regions'));
  }
  if (undrawableCount > 0) {
    missing.push(counted(undrawableCount, 'detection', 'detections'));
  }

  if (missing.length > 0) {
    bar.append(
      el('p', {
        class: 'status-warning',
        text: `${missing.join(' and ')} not shown in the Atlas.`,
      }),
    );
  }

  return bar;
}
