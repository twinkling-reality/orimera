/** Atlas orientation and omission disclosures. */

import type { OccurrenceKind } from '@orimera/graph-client';
import { el } from './dom.js';

/** Fixed by interaction-model.md 6.2 and shown with Atlas Map, where layout can be misread. */
export const MAP_ORIENTATION_CAPTION =
  'Positions show how these memories relate, not where they happened.';

export interface StatusInput {
  readonly omittedRegionCount: number;
  readonly undrawable: ReadonlyMap<OccurrenceKind, number>;
  readonly sourceMediaNotices?: readonly string[];
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

  for (const notice of input.sourceMediaNotices ?? []) {
    bar.append(el('p', { class: 'status-warning source-status', text: notice }));
  }

  return bar;
}
