/** Atlas orientation and omission disclosures. */

import type { OccurrenceKind } from '@orimera/graph-client';
import { el } from './dom.js';

/** Fixed by interaction-model.md 6.2 and shown with Atlas Map, where layout can be misread. */
export const MAP_ORIENTATION_CAPTION =
  'Positions show how these memories relate, not where they happened.';

export interface StatusInput {
  readonly omittedRegionCount: number;
  readonly undrawable: ReadonlyMap<OccurrenceKind, number>;
  /**
   * Everything the world could not load, one line each, in the order it was discovered.
   *
   * Renamed from `sourceMediaNotices` when reconstruction geometry gained a production loader and
   * a second kind of notice arrived. The name says what the field is rather than where the first
   * caller's strings came from, so the next kind does not need a third field or a misleading
   * second use of this one.
   */
  readonly notices?: readonly string[];
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function buildStatus(input: StatusInput): HTMLElement {
  const bar = el('footer', { class: 'status' });

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

  for (const notice of input.notices ?? []) {
    bar.append(el('p', { class: 'status-warning source-status', text: notice }));
  }

  return bar;
}
