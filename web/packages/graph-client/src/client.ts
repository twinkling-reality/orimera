/**
 * The real client. Reads the graph, runs a Selection, resolves a citation.
 *
 * This is the file the STATUS note in `index.ts` used to say was a stub. It is not one now, and
 * the read model above it did not have to change to make that true, which is what the boundary
 * was for.
 *
 * **The adapter is where the honesty lives.** The read model was designed against a fuller
 * system than exists, and this file is the single auditable place where the difference is
 * recorded. Every field the server cannot answer is listed in `adaptSnapshot` with the reason,
 * because a zero that means 'not implemented' and a zero that means 'none' look identical in a
 * user interface and only one of them is true.
 *
 * **An island is decided here, not on the server.** ADR-0005 records that whether an island is
 * one capture or a place-on-a-trip cluster is OPEN "until the real distribution of the corpus
 * has been measured", so the server returns capture ids and a grouping, and this maps them
 * through an injectable function.
 *
 * THE CORPUS HAS NOW BEEN MEASURED, so the default has changed. 80 photographs across five
 * visits to three places cluster into five scene groups of sixteen. One island per capture would
 * be 80 islands, and `solveLayout` refuses more than five and says why: "a force layout whose
 * behaviour was never examined above five islands should fail loudly rather than produce a
 * plausible-looking arrangement nobody has checked". One island per scene group is five. The
 * default is therefore the group, falling back to the capture for anything the grouping did not
 * place, which is the honest answer for a photograph with no usable clock.
 *
 * The function is still injectable and the server still ships no island id, so this remains one
 * argument to have rather than a server change, which is exactly what it was kept for.
 */

import type {
  AnchorIdRef,
  AssertionProducer,
  AssertionView,
  EntityIdRef,
  EntityRecord,
  EvidenceHandle,
  GraphSnapshot,
  HistoryEvent,
  IslandIdRef,
  IslandRecord,
  LinkState,
  MatchProposalView,
  OccurrenceRecord,
  ResolvedEvidence,
} from './read-model.js';
import { Transport, type TransportOptions } from './transport.js';

export interface AssertionPayload {
  readonly assertion_id: string;
  readonly kind: string;
  readonly predicate_key: string;
  readonly status: string;
  readonly object_value: unknown;
  readonly support_span_ids: readonly string[];
  readonly produced_by: Readonly<Record<string, unknown>>;
  readonly asserted_at: string;
  readonly supersedes: string | null;
}

export interface HistoryPayload {
  readonly event_id: string;
  readonly event_type: string;
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly undoes: string | null;
  readonly created_at: string;
}

/** What the API's `GET /graph` answers with. Server terms, not read-model terms. */
export interface GraphPayload {
  readonly state_version: number;
  readonly entities: readonly {
    readonly entity_id: string;
    readonly entity_class: string;
    readonly display_name: string | null;
    readonly merged_into: string | null;
    readonly occurrence_count: number;
    readonly capture_ids: readonly string[];
    readonly first_seen: string | null;
    readonly last_seen: string | null;
    readonly open_question_count: number;
    readonly assertions: readonly AssertionPayload[];
    readonly history: readonly HistoryPayload[];
    readonly contradictions: readonly Readonly<Record<string, unknown>>[];
  }[];
  readonly occurrences: readonly {
    readonly occurrence_id: string;
    readonly capture_id: string;
    readonly occurrence_class: string;
    readonly primary_span_id: string;
    readonly entity_id: string | null;
    readonly link_state: string | null;
    readonly captured_at: string | null;
  }[];
  readonly proposals: readonly {
    readonly proposal_id: string;
    readonly occurrence_id: string;
    readonly entity_id: string;
    readonly rank: number;
    readonly outcome: string;
    readonly basis: Readonly<Record<string, unknown>>;
    readonly suppressed_by_rejection: boolean;
    readonly support_span_ids: readonly string[];
  }[];
  readonly scene_groups: readonly {
    readonly group_id: string;
    readonly ordinal: number;
    readonly capture_ids: readonly string[];
    readonly first_utc: string | null;
    readonly last_utc: string | null;
    readonly member_count: number;
    readonly positioned_member_count: number;
    readonly radius_m: number | null;
    readonly centroid_lat_e7: number | null;
    readonly centroid_lon_e7: number | null;
  }[];
  readonly never_same: readonly (readonly [string, string])[];
  readonly deleted_entity_ids: readonly string[];
}

export interface SelectionSupport {
  readonly span_id: string;
  readonly assertion_id: string | null;
  readonly dimension: string;
  readonly entity_id: string | null;
}

export interface SelectionCapture {
  readonly capture_id: string;
  readonly blob: string;
  readonly captured_at: string | null;
  readonly support: readonly SelectionSupport[];
}

export interface SelectionView {
  readonly captures: readonly SelectionCapture[];
  readonly entities: readonly {
    readonly entity_id: string;
    readonly entity_class: string;
    readonly display_name: string | null;
    readonly capture_count: number;
  }[];
  readonly total_matched: number;
  readonly truncated: boolean;
  readonly includes_proposals: boolean;
}

/** How a capture becomes an island. See the module comment on why this is a parameter. */
export type IslandOf = (captureId: string) => IslandIdRef;

export interface ClientOptions extends TransportOptions {
  readonly islandOf?: IslandOf;
}

/**
 * The default: a capture belongs to the scene group that contains it, or stands alone.
 *
 * Built from the payload rather than being a constant, because the grouping is data the server
 * computed and the mapping cannot be known without it. A capture in no group becomes its own
 * island rather than being dropped or bundled into a nearby one: a photograph the clusterer
 * could not place is a real photograph, and hiding it would be losing evidence to a layout
 * decision.
 */
function groupIslands(payload: GraphPayload): IslandOf {
  const byCapture = new Map<string, IslandIdRef>();
  for (const group of payload.scene_groups) {
    for (const captureId of group.capture_ids) {
      byCapture.set(captureId, group.group_id as IslandIdRef);
    }
  }
  return (captureId) => byCapture.get(captureId) ?? (captureId as IslandIdRef);
}

export class OrimeraClient {
  readonly #transport: Transport;
  readonly #islandOf: IslandOf | undefined;

  constructor(options: ClientOptions) {
    this.#transport = new Transport(options);
    // Held as the caller's OVERRIDE rather than resolved to a default here, because the default
    // is built from the payload's own grouping and there is no payload yet.
    this.#islandOf = options.islandOf;
  }

  /** The whole graph at one state version. What the index and turn generation run against. */
  async snapshot(): Promise<GraphSnapshot> {
    return adaptSnapshot(
      await this.#transport.getJson<GraphPayload>('/graph'),
      this.#islandOf,
    );
  }

  /** Resolve a Selection. The same call whichever surface built the plan. */
  async selection(plan: unknown): Promise<SelectionView> {
    return this.#transport.postJson<SelectionView>('/selection', plan);
  }

  /** The named entities this session may filter by. */
  async catalogue(): Promise<SelectionView['entities']> {
    return this.#transport.getJson<SelectionView['entities']>(
      '/selection/catalogue',
    );
  }

  /**
   * The URL of the original media a citation resolves to.
   *
   * A URL rather than bytes, because the browser fetches an `<img src>` far better than this
   * code can, and because the endpoint supports range requests that the browser already knows
   * how to make. The token is in the header on every other call and cannot be here, so this is
   * the one place a caller has to decide: use it where the request carries credentials another
   * way, and use `evidenceBytes` where it does not.
   */
  evidenceUrl(handle: EvidenceHandle): string {
    return this.#transport.url(`/evidence/${handle}`);
  }

  async evidenceBytes(handle: EvidenceHandle): Promise<Blob> {
    const response = await this.#transport.getBytes(`/evidence/${handle}`);
    return response.blob();
  }

  /**
   * The `EvidenceResolver` the provenance panel takes.
   *
   * One request per handle, deliberately, rather than a batch endpoint that does not exist. A
   * batch endpoint is worth adding when a panel is measured to need one; adding it now would be
   * adding a route nothing calls.
   */
  async resolve(
    handles: readonly EvidenceHandle[],
  ): Promise<readonly ResolvedEvidence[]> {
    const items = await Promise.all(
      handles.map(async (handle) => {
        const response = await this.#transport.getBytes(`/evidence/${handle}`);
        return {
          handle,
          // The server says which modality this span is; it is not assumed from the shape of
          // the request. A frame region and a whole still image are different citations.
          modality: (response.headers.get('x-orimera-modality') ??
            'still_image') as ResolvedEvidence['modality'],
          sourceKey: this.#transport.url(`/evidence/${handle}`),
          capturedAtMs: headerMs(response, 'x-orimera-captured-at'),
          capturedAtUncertaintyMs: headerInt(
            response,
            'x-orimera-captured-at-uncertainty-ms',
          ),
          region: null,
        } as ResolvedEvidence;
      }),
    );
    return items;
  }
}

/**
 * Server payload to read model, with every gap stated.
 *
 * Four fields the read model asks for that the server cannot answer today. Each is set to the
 * value that is TRUE rather than the value that looks complete, and each says why:
 *
 *   - `confidence`: null on every entity and 'low' on every occurrence link. A confirmed link is
 *     a human decision and has no confidence, it has support, which is exactly what the read
 *     model's own comment says. Nothing here is inference-backed yet because nothing proposes
 *     automatically, so there is no band to report.
 *   - `citingAnswerCount`: 0, and it means 'no answer is stored anywhere', not "no answer cites
 *     this". The field exists because a tier 3 confirmation must state how many answers lose
 *     their citation. Until answers are stored, a tier 3 confirmation cannot state it, and the
 *     gate refuses tier 3 anyway.
 *   - `anchorIds` on a proposal: the occurrence's own id is used as its anchor. An anchor is a
 *     placed object in the Atlas and the placement is the client's, so this is the identity map
 *     until a layout exists to ask.
 *   - `status`: derived from what the server knows, and the mapping is exact rather than
 *     approximate. A name is only ever written by an active `kind='user'` assertion, so an
 *     entity with one is `user_asserted`. An entity with `merged_into` set is `merged_away`.
 *     Everything else is `inferred_only`: it exists because a detector saw something and no
 *     person has spoken about it. `needs_review` is deliberately not produced, because it would
 *     mean 'a proposal is waiting' and nothing proposes automatically yet.
 */
export function adaptSnapshot(
  payload: GraphPayload,
  islandOf?: IslandOf,
): GraphSnapshot {
  const toIsland = islandOf ?? groupIslands(payload);
  const entities: readonly EntityRecord[] = payload.entities.map(
    (row): EntityRecord => ({
      entityId: row.entity_id as EntityIdRef,
      kind: row.entity_class as EntityRecord['kind'],
      displayName: row.display_name,
      status: entityStatus(row.merged_into, row.display_name),
      occurrenceCount: row.occurrence_count,
      islandIds: row.capture_ids.map(toIsland),
      firstSeenMs: toMs(row.first_seen),
      lastSeenMs: toMs(row.last_seen),
      confidence: null,
      openQuestionCount: row.open_question_count,
      citingAnswerCount: 0,
      assertions: row.assertions.map(adaptAssertion),
      // Empty because nothing writes a relation predicate yet, not because relations are ignored.
      // The vocabulary seeds no predicate whose object is another entity.
      relations: [],
      // Empty because nothing writes a dispute yet. The read model carries the field because 5.4
      // requires a contradicting inference to be recorded and surfaced, never applied.
      contradictions: [],
      history: row.history.map((event) =>
        adaptHistory(event, payload.state_version),
      ),
      mergedInto: (row.merged_into as EntityIdRef | null) ?? null,
    }),
  );

  const occurrences: readonly OccurrenceRecord[] = payload.occurrences.map(
    (row): OccurrenceRecord => ({
      occurrenceId: row.occurrence_id as OccurrenceRecord['occurrenceId'],
      anchorId: row.occurrence_id as AnchorIdRef,
      islandId: toIsland(row.capture_id),
      kind: row.occurrence_class as OccurrenceRecord['kind'],
      entityId: (row.entity_id as EntityIdRef | null) ?? null,
      linkState: (row.link_state ?? 'proposed') as LinkState,
      confidence: 'low',
      evidence: [row.primary_span_id as EvidenceHandle],
      capturedAtMs: toMs(row.captured_at),
    }),
  );

  const matchProposals: readonly MatchProposalView[] = payload.proposals.map(
    (row): MatchProposalView => ({
      matchId: row.proposal_id,
      entityId: row.entity_id as EntityIdRef,
      candidateEntityId: null,
      occurrenceIds: [row.occurrence_id as OccurrenceRecord['occurrenceId']],
      anchorIds: [row.occurrence_id as AnchorIdRef],
      islandIds: [],
      confidence: 'low',
      basisModalities: readModalities(row.basis),
      evidence: row.support_span_ids as readonly EvidenceHandle[],
      suppressedByRejection: row.suppressed_by_rejection,
      newModality: null,
    }),
  );

  return {
    stateVersion: payload.state_version,
    entities,
    occurrences,
    islands: buildIslands(payload, toIsland),
    matchProposals,
    neverSame: payload.never_same.map(
      ([a, b]) => [a as EntityIdRef, b as EntityIdRef] as const,
    ),
    deletedEntityIds: payload.deleted_entity_ids as readonly EntityIdRef[],
  };
}

/**
 * The islands, built from the grouping and from whatever the grouping did not place.
 *
 * Derived from the SAME `islandOf` the occurrences went through, rather than read straight off
 * `scene_groups`. A caller that injected its own function gets islands that match its own
 * occurrences; a set derived independently from the payload would silently disagree with the
 * anchors placed inside it, and the symptom would be an anchor rendered in a region it does not
 * belong to.
 *
 * `spreadMetres` is carried through only for a group whose members had a fix. A radius reported
 * for a group clustered on time alone would be a distance nothing measured.
 */
function buildIslands(payload: GraphPayload, islandOf: IslandOf): readonly IslandRecord[] {
  const byIsland = new Map<IslandIdRef, IslandRecord>();

  for (const group of payload.scene_groups) {
    const islandId = islandOf(group.capture_ids[0] ?? group.group_id);
    byIsland.set(islandId, {
      islandId,
      captureIds: group.capture_ids,
      firstCapturedAtMs: toMs(group.first_utc),
      lastCapturedAtMs: toMs(group.last_utc),
      positionedCaptureCount: group.positioned_member_count,
      spreadMetres: group.positioned_member_count > 0 ? group.radius_m : null,
    });
  }

  // Anything the grouping did not place. One capture, one island, and the times are the times
  // its own occurrences carry rather than a group's.
  const grouped = new Set(payload.scene_groups.flatMap((group) => group.capture_ids));
  for (const row of payload.occurrences) {
    if (grouped.has(row.capture_id)) continue;
    const islandId = islandOf(row.capture_id);
    const existing = byIsland.get(islandId);
    const atMs = toMs(row.captured_at);
    byIsland.set(islandId, {
      islandId,
      captureIds: [row.capture_id],
      firstCapturedAtMs: minOf(existing?.firstCapturedAtMs ?? null, atMs),
      lastCapturedAtMs: maxOf(existing?.lastCapturedAtMs ?? null, atMs),
      positionedCaptureCount: 0,
      spreadMetres: null,
    });
  }

  // Ordered by when the photographs were taken, which is the layout solver's ordering key. An
  // island with no usable clock sorts last rather than to the epoch, because sorting it first
  // would make an undated photograph the anchor of the user's spatial memory.
  return [...byIsland.values()].sort((a, b) => {
    const left = a.firstCapturedAtMs ?? Number.POSITIVE_INFINITY;
    const right = b.firstCapturedAtMs ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    return a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0;
  });

  function minOf(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
  }

  function maxOf(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.max(a, b);
  }
}

function toMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The modalities a proposal was built from, from its recorded basis. Never invented. */
function readModalities(
  basis: Readonly<Record<string, unknown>>,
): readonly string[] {
  const declared = basis['modalities'];
  return Array.isArray(declared)
    ? declared.filter((m): m is string => typeof m === 'string')
    : [];
}

/**
 * How a stored entity presents in the index's Status facet.
 *
 * `user_asserted` rather than `confirmed` for a named entity, and the distinction is the
 * product's: a name is a thing a person said, and `confirmed` in this vocabulary is about a link
 * having been agreed rather than about an entity having been named.
 */
function entityStatus(
  mergedInto: string | null,
  displayName: string | null,
): EntityRecord['status'] {
  if (mergedInto !== null) return 'merged_away';
  if (displayName !== null) return 'user_asserted';
  return 'inferred_only';
}

function headerMs(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function headerInt(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * One stored claim, with what produced it.
 *
 * `confidence` is null for `capture` and `user` because those do not have confidence, they have
 * support, which is the read model's own wording. An inference could carry a band, and does not
 * yet: the server records the model's qualitative band on the occurrence rather than on the
 * assertion, and inventing one here from a score is exactly the thing epi-4 forbids.
 */
function adaptAssertion(row: AssertionPayload): AssertionView {
  return {
    assertionId: row.assertion_id as AssertionView['assertionId'],
    kind: row.kind as AssertionView['kind'],
    predicateKey: row.predicate_key,
    status: row.status as AssertionView['status'],
    objectValue: row.object_value,
    supportEvidence: row.support_span_ids as readonly EvidenceHandle[],
    producedBy: adaptProducer(row),
    confidence: null,
    assertedAtMs: toMs(row.asserted_at) ?? 0,
    supersedes: (row.supersedes as AssertionView['supersedes']) ?? null,
  };
}

function adaptProducer(row: AssertionPayload): AssertionProducer {
  const by = row.produced_by['by'];
  if (by === 'user') {
    return { by: 'user', statedAtMs: toMs(row.asserted_at) ?? 0 };
  }
  if (by === 'pipeline') {
    return {
      by: 'pipeline',
      runId: String(row.produced_by['run_id'] ?? ''),
      // The model that produced it is on the pipeline event rather than on the assertion, so
      // this is empty rather than guessed. A model ref that named the wrong model would be
      // worse than one that names none.
      modelRef: '',
    };
  }
  if (by === 'external') {
    const source = (row.produced_by['source'] ?? {}) as Record<string, unknown>;
    return {
      by: 'external',
      url: String(source['url'] ?? ''),
      retrievedAtMs: toMs(String(source['retrieved_at'] ?? '')) ?? 0,
      snapshotHash: String(source['snapshot_sha256'] ?? ''),
    };
  }
  return { by: 'capture', mediaKey: row.support_span_ids[0] ?? '' };
}

/**
 * One identity decision, as the entity detail view renders it.
 *
 * `actor` is 'user' for every event this system writes, and that is a fact rather than a
 * simplification: every function that writes an identity event takes an actor and there is no
 * path by which the system writes one on its own. When automatic proposals exist, the event they
 * write will be a `match_proposal` row rather than an identity event, and this will still be
 * true.
 */
function adaptHistory(row: HistoryPayload, stateVersion: number): HistoryEvent {
  return {
    eventId: row.event_id,
    type: row.event_type as HistoryEvent['type'],
    actor: 'user',
    atMs: toMs(row.created_at) ?? 0,
    stateVersion,
    // The verbatim utterance lives on the update proposal that produced the decision, and the
    // identity event records the decision. Null rather than a paraphrase.
    rawUtterance: null,
    summaryKey: `identity.${row.event_type}`,
    undoes: row.undoes,
  };
}
