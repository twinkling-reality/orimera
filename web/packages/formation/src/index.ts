/**
 * @exulanica/formation
 *
 * The formation contract: what a pipeline stage event is, the reducer that turns a stream of them
 * into one state, the labels written from that state, and the visual it maps to.
 *
 * **Its own package because two surfaces need it and neither may import the other.** The
 * signed-out page demonstrates formation with a scripted source; the authenticated app watches a
 * real one. `landing` may not import `app` and `app` may not import `landing`, so a contract they
 * share has to sit under both. Duplicating it would be two places for the ordered stage list to
 * drift, and that list is what the reducer uses to reject an out-of-order event: a divergence
 * would silently truncate a stream rather than fail.
 *
 * **The reducer half has no DOM and must not gain one.** `events.ts`, `state.ts`, `labels.ts` and
 * `visual.ts` are pure functions, testable headless, and the renderer reads `FormationVisual`
 * rather than reading events. `http-source.ts` is the exception and is the only file here that
 * knows a network exists; `test/purity.test.ts` asserts the split rather than trusting it.
 *
 * **The ordered stage list is duplicated in Python**, in `exulanica/ingest/formation.py`, because
 * neither language can import the other. `tests/test_formation_stream.py` reads this package's
 * copy and compares.
 */

export * from './events.js';
export * from './state.js';
export * from './labels.js';
export * from './visual.js';
export type { FormationEventSource } from './source.js';
export * from './mock-source.js';
export type {
  HttpFormationOptions,
  StreamFetch,
  StreamReader,
  StreamResponse,
} from './http-source.js';
export { HttpFormationEventSource, parseFrame } from './http-source.js';
