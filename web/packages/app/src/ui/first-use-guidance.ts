export const FIRST_USE_GUIDANCE_KEY = 'orimera.atlas.first-use.v1';
export const FIRST_USE_COMMAND_GUIDANCE_KEY = 'orimera.atlas.first-use.commands.v1';

export type FirstUsePhase = 'arrival' | 'traversal' | 'companion' | 'complete';
export type FirstUseMode = 'traverse' | 'converse';

export interface FirstUsePromptAction {
  readonly label: string;
  readonly key?: string;
}

export interface FirstUsePrompt {
  readonly statement: string;
  readonly actions: readonly FirstUsePromptAction[];
}

interface FirstUseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FirstUseGuidance {
  phase(): FirstUsePhase;
  prompt(mode: FirstUseMode): FirstUsePrompt | null;
  commandLegendVisible(): boolean;
  observeMode(mode: FirstUseMode): boolean;
  observeMovement(): boolean;
  observeCommand(): boolean;
  complete(): boolean;
}

const PHASES = new Set<FirstUsePhase>(['arrival', 'traversal', 'companion', 'complete']);

function readPhase(storage: FirstUseStorage): FirstUsePhase {
  try {
    const stored = storage.getItem(FIRST_USE_GUIDANCE_KEY) as FirstUsePhase | null;
    return stored !== null && PHASES.has(stored) ? stored : 'arrival';
  } catch {
    return 'arrival';
  }
}

function readCommandLegend(storage: FirstUseStorage): boolean {
  try {
    return storage.getItem(FIRST_USE_COMMAND_GUIDANCE_KEY) !== 'used';
  } catch {
    return true;
  }
}

/**
 * A four-state orientation, not a tour. Progress follows demonstrated actions and is saved on the
 * device; there are no timers, route locks, invented completion metrics, or graph writes.
 */
export function createFirstUseGuidance(storage: FirstUseStorage): FirstUseGuidance {
  let phase = readPhase(storage);
  let commandLegendVisible = readCommandLegend(storage);

  const setPhase = (next: FirstUsePhase): boolean => {
    if (phase === next) return false;
    phase = next;
    try {
      storage.setItem(FIRST_USE_GUIDANCE_KEY, next);
    } catch {
      // Storage refusal must not turn optional orientation into a boot failure.
    }
    return true;
  };

  return {
    phase: () => phase,
    commandLegendVisible: () => commandLegendVisible,
    prompt(mode) {
      if (phase === 'complete') return null;
      if (phase === 'companion') {
        return Object.freeze({
          statement: 'The Companion helps resolve what your memories show.',
          actions: Object.freeze([{ key: 'X', label: 'Call Companion' }]),
        });
      }
      if (mode === 'converse') {
        return Object.freeze({
          statement: 'Atlas arranges your memories as a world.',
          actions: Object.freeze([{ label: 'Click to enter' }]),
        });
      }
      return Object.freeze({
        statement: 'Move through this memory.',
        actions: Object.freeze([
          { key: 'W A S D', label: 'Move' },
          { key: 'X', label: 'Companion' },
        ]),
      });
    },
    observeMode(mode) {
      return mode === 'traverse' && phase === 'arrival' ? setPhase('traversal') : false;
    },
    observeMovement() {
      return phase === 'arrival' || phase === 'traversal' ? setPhase('companion') : false;
    },
    observeCommand() {
      if (!commandLegendVisible) return false;
      commandLegendVisible = false;
      try {
        storage.setItem(FIRST_USE_COMMAND_GUIDANCE_KEY, 'used');
      } catch {
        // The legend may return next session, but the command itself must still work.
      }
      return true;
    },
    complete() {
      return setPhase('complete');
    },
  };
}
