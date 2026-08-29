/**
 * An in-memory graph source for an explicitly selected development preview.
 *
 * This module has its own package entry point, `@orimera/graph-client/fixture`. The normal client
 * entry point does not export it, so a live application cannot acquire fixture data through an
 * accidental main-package import. The application still owns the stronger build-time rule that
 * decides whether this entry point may be loaded at all.
 *
 * The fixture is expressed in the API's `GraphPayload` vocabulary and passes through the same
 * adapter as an HTTP response. It does not create a second read model, make a request, accept a
 * token, or act as a fallback for a failed live source.
 */

import type { GraphSource } from './source.js';
import { adaptSnapshot } from './snapshot.js';
import type { IslandOf } from './islands.js';
import type { GraphSnapshot } from './read-model.js';
import type { GraphPayload } from './wire.js';

export class FixtureGraphSource implements GraphSource {
  readonly #payload: GraphPayload;
  readonly #islandOf: IslandOf | undefined;

  constructor(payload: GraphPayload, islandOf?: IslandOf) {
    // Keep the fixture stable even if the object used to construct it is later edited by a test
    // or a preview control. Every read starts from this private JSON-compatible copy.
    this.#payload = structuredClone(payload);
    this.#islandOf = islandOf;
  }

  async snapshot(): Promise<GraphSnapshot> {
    return adaptSnapshot(this.#payload, this.#islandOf);
  }
}
