/**
 * The permanent bar. What the world is made of, and the one sentence that governs looking at it.
 *
 * **The standing caption is never dismissible**, and that is why it lives in a module with no
 * control that hides it rather than in a component with a close button somebody chose not to add.
 * interaction-model.md 6.2 fixes the wording, and it is the user-facing half of the coordinate
 * rule in 1.2: an island's position in the Atlas carries no real-world meaning, so a viewer must
 * be told that permanently and not in a tooltip they can dismiss and forget.
 *
 * **The rung is displayed rather than hidden.** product-specification.md 5.1: "the reconstruction
 * rung a scene earned is displayed, not hidden. The ladder is the honesty feature." A region with
 * no geometry says so, in the same place and the same voice as one that has some.
 *
 * **Nothing dropped is dropped silently.** Regions the layout solver would not take, and
 * detections the scene graph has no shape for, are counted and stated. A world that quietly
 * showed less than it holds reads as the whole world.
 */

import type { GraphSnapshot } from '@orimera/graph-client';
import type { OccurrenceKind } from '@orimera/graph-client';
import { rungProperties, type ReconstructionRung } from '@orimera/atlas-core';
import { say } from './copy.js';
import { el } from './dom.js';

/** Fixed by interaction-model.md 6.2. Exported so a test can assert it survives a redesign. */
export const STANDING_CAPTION =
  'Positions show how these memories relate, not where they happened.';

export interface StatusInput {
  readonly snapshot: GraphSnapshot;
  readonly regionCount: number;
  /** The rung every region in this world earned. One value while nothing reconstructs. */
  readonly rung: ReconstructionRung;
  readonly omittedRegionCount: number;
  readonly undrawable: ReadonlyMap<OccurrenceKind, number>;
}

export function buildStatus(input: StatusInput): HTMLElement {
  const bar = el('footer', { class: 'status' });
  const { snapshot } = input;

  bar.append(
    el('p', { class: 'standing-caption', text: STANDING_CAPTION }),
    el('p', {
      class: 'status-facts',
      text:
        `${input.regionCount} regions, ` +
        `${snapshot.occurrences.length} detections, ` +
        `${snapshot.entities.length} identified, ` +
        `state version ${snapshot.stateVersion}`,
    }),
    el('p', { class: 'status-rung', text: say(rungProperties(input.rung).labelKey) }),
  );

  if (input.omittedRegionCount > 0) {
    bar.append(
      el('p', {
        class: 'status-warning',
        text:
          `${input.omittedRegionCount} regions are not shown: the layout solver is specified ` +
          'for five and refuses to arrange more.',
      }),
    );
  }
  for (const [kind, count] of input.undrawable) {
    bar.append(
      el('p', {
        class: 'status-warning',
        text: `${count} ${kind} detections have no shape in the Atlas and are not drawn.`,
      }),
    );
  }
  return bar;
}
