/**
 * The formation module.
 *
 * Pure TypeScript with no DOM: the reducer, the labels and the state-to-visual mapping are all
 * testable headless, and the renderer reads `FormationVisual` rather than reading events. That
 * split is what lets this be wired to the real provenance ledger later without a redesign; the
 * only file that changes is which `FormationEventSource` is constructed.
 */

export * from './events.js';
export * from './state.js';
export * from './labels.js';
export * from './visual.js';
export type { FormationEventSource } from './source.js';
export * from './mock-source.js';
