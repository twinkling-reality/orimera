export type CompanionSide = 'left' | 'right';

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CompanionPlacementInput {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly memoryBounds: ScreenRect | null;
  readonly preferredSide: CompanionSide;
}

/** The supplied visual-novel reference is a fixed composition, not a mirrored card layout. */
export interface CompanionPlacement {
  readonly presenceSide: 'center';
  readonly speechSide: 'center';
  readonly choicesSide: 'right';
  readonly basis: 'reference-fixed';
}

/**
 * Return the authored encounter composition.
 *
 * Earlier versions mirrored the entire interface to avoid a projected memory rectangle. That
 * made answer order unpredictable and moved the dialogue away from the reference. The memory is
 * intentionally the backdrop now: character at centre, answers right, speech across the bottom.
 */
export function resolveCompanionPlacement(_input: CompanionPlacementInput): CompanionPlacement {
  return Object.freeze({
    presenceSide: 'center',
    speechSide: 'center',
    choicesSide: 'right',
    basis: 'reference-fixed',
  });
}
