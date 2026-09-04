/** Atlas orientation and omission disclosures. */

import type {
  OccurrenceKind,
  ReconstructionRungRef,
  RenderingSubstrate,
} from '@orimera/graph-client';
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
  readonly reconstructionScenes?: readonly ReconstructionRungDisclosure[];
}

export interface ReconstructionRungDisclosure {
  readonly sceneId: string;
  readonly recordedRung: ReconstructionRungRef | null;
  readonly displayedRung: ReconstructionRungRef;
  readonly registeredMemberCount: number;
  readonly memberCount: number;
  readonly renderingSubstrate: RenderingSubstrate;
  readonly reasons: readonly string[];
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

  for (const scene of input.reconstructionScenes ?? []) {
    const details = el('details', { class: 'reconstruction-rung' });
    details.dataset.sceneId = scene.sceneId;
    const recorded = scene.recordedRung === null ? 'unreadable' : String(scene.recordedRung);
    const substrate = scene.renderingSubstrate === 'posed_point_maps'
      ? 'posed point maps'
      : 'source photographs';
    details.append(
      el('summary', {
        text: `Recorded rung ${recorded}; showing rung ${scene.displayedRung} from ${substrate}.`,
      }),
      el('p', {
        text: `${scene.registeredMemberCount} of ${scene.memberCount} photographs registered.`,
      }),
    );
    if (scene.reasons.length > 0) {
      const reasons = el('ul', { class: 'reconstruction-rung-reasons' });
      for (const reason of scene.reasons) reasons.append(el('li', { text: reason }));
      details.append(reasons);
    }
    bar.append(details);
  }

  return bar;
}
