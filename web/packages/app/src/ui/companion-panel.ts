/**
 * Compatibility entry point for the UI name used before the exchange became a composed encounter.
 * New code imports `companion-encounter`; keeping this re-export avoids a needless flag day for
 * focused tests and external development harnesses.
 */
export type {
  CompanionEncounter as CompanionPanel,
  CompanionEncounterOptions,
  CompanionHandlers,
  PanelState,
} from './companion-encounter.js';
export { buildCompanionEncounter as buildCompanionPanel } from './companion-encounter.js';
