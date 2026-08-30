// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { adaptSnapshot, type OccurrenceRecord } from '@orimera/graph-client';

import { isAtlasPreview, previewCredentials } from '../src/config.js';
import { previewApiResponse } from '../src/dev/preview-api.js';
import { PREVIEW_GRAPH } from '../src/dev/preview-graph.js';
import { EvidenceCache } from '../src/evidence.js';
import { buildScene } from '../src/scene.js';
import { buildDetail } from '../src/ui/detail.js';
import { buildLibrary } from '../src/ui/library.js';
import { buildStatus, PREVIEW_CAPTION } from '../src/ui/status.js';

describe('Atlas development preview', () => {
  it('requires both an explicit query and a development build', () => {
    expect(isAtlasPreview('?preview=1', true)).toBe(true);
    expect(isAtlasPreview('?preview=0', true)).toBe(false);
    expect(isAtlasPreview('?preview=1', false)).toBe(false);
  });

  it('uses an isolated endpoint and a non-user preview credential', () => {
    expect(previewCredentials('http://127.0.0.1:5173')).toEqual({
      baseUrl: 'http://127.0.0.1:5173/preview-api',
      token: 'atlas-preview-read-only',
    });
  });

  it('adapts the typed payload into a drawable multi-region Atlas', () => {
    const snapshot = adaptSnapshot(PREVIEW_GRAPH);
    const built = buildScene(snapshot);
    expect(snapshot.entities).toHaveLength(4);
    expect(snapshot.islands).toHaveLength(3);
    expect(built.scene.islands).toHaveLength(3);
    expect(built.omitted).toHaveLength(0);
  });

  it('uses backend-valid UUID shapes and server-reachable link states', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = [
      ...PREVIEW_GRAPH.entities.flatMap((entity) => [
        entity.entity_id,
        ...entity.capture_ids,
        ...entity.assertions.flatMap((assertion) => [
          assertion.assertion_id,
          ...assertion.support_span_ids,
        ]),
        ...entity.history.map((event) => event.event_id),
      ]),
      ...PREVIEW_GRAPH.occurrences.flatMap((occurrence) => [
        occurrence.occurrence_id,
        occurrence.capture_id,
        occurrence.primary_span_id,
      ]),
      ...PREVIEW_GRAPH.proposals.map((proposal) => proposal.proposal_id),
      ...PREVIEW_GRAPH.scene_groups.map((group) => group.group_id),
    ];
    expect(ids.every((id) => uuid.test(id))).toBe(true);
    expect(
      PREVIEW_GRAPH.occurrences.every(
        (occurrence) =>
          (occurrence.entity_id === null && occurrence.link_state === null) ||
          occurrence.link_state === 'confirmed' ||
          occurrence.link_state === 'auto_provisional',
      ),
    ).toBe(true);
    expect(PREVIEW_GRAPH.proposals.every((proposal) => proposal.outcome === 'surfaced')).toBe(true);
    expect(PREVIEW_GRAPH.state_version).toBeGreaterThanOrEqual(PREVIEW_GRAPH.occurrences.length);
  });

  it('serves only preview reads and refuses every mutation method', () => {
    expect(previewApiResponse('GET', '/graph').statusCode).toBe(200);
    expect(previewApiResponse('GET', '/formation').body).toEqual([]);
    expect(previewApiResponse('GET', '/evidence/example').statusCode).toBe(404);
    expect(previewApiResponse('GET', '/identity').statusCode).toBe(404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const decision = previewApiResponse(method, '/identity/confirm');
      expect(decision.statusCode).toBe(403);
      expect(decision.body).toMatchObject({ code: 'preview_read_only' });
    }
  });

  it('states the preview limitations in the visible surface', () => {
    const status = buildStatus({ omittedRegionCount: 0, undrawable: new Map(), preview: true });
    const disclosure = status.querySelector('.preview-disclosure');
    expect(disclosure?.textContent).toBe(PREVIEW_CAPTION);
    expect(disclosure?.textContent).toContain('Development preview');
    expect(disclosure?.textContent).toContain('synthetic');
    expect(disclosure?.textContent).toContain('read-only');
    expect(disclosure?.textContent).toContain('evidence unavailable');
    expect(disclosure?.querySelector('button, a, input')).toBeNull();
  });

  it('omits naming and disables evidence before either can make a request', () => {
    const evidenceBytes = vi.fn(async () => new Blob());
    const detail = buildDetail(
      new EvidenceCache({ evidenceBytes }),
      { onClose: vi.fn(), onName: vi.fn(), onEvidenceOpened: vi.fn(), onLocate: vi.fn() },
      { preview: true },
    );
    const occurrence: OccurrenceRecord = {
      occurrenceId: 'preview-occurrence',
      anchorId: 'preview-occurrence',
      islandId: 'preview-region',
      kind: 'object',
      entityId: null,
      linkState: 'proposed',
      confidence: 'low',
      evidence: ['preview-span'],
      capturedAtMs: 1_744_464_280_000,
    };

    detail.showOccurrence(occurrence);
    expect(detail.root.querySelector('.name-offer')).toBeNull();
    expect(detail.root.querySelector('.preview-read-only-note')?.textContent).toContain('read-only');
    const evidence = detail.root.querySelector<HTMLButtonElement>('.citation-open');
    expect(evidence?.disabled).toBe(true);
    evidence?.click();
    expect(evidenceBytes).not.toHaveBeenCalled();
  });

  it('does not promise source photographs from the synthetic Index', () => {
    const snapshot = adaptSnapshot(PREVIEW_GRAPH);
    const library = buildLibrary(
      { onEntity: vi.fn(), onOccurrence: vi.fn(), onSearch: vi.fn() },
      { preview: true },
    );
    library.render(snapshot, '', null);
    const note = library.root.querySelector('.rail-note')?.textContent ?? '';
    expect(note).toContain('synthetic');
    expect(note).toContain('unavailable');
    expect(note).not.toContain('opens the photograph');
  });
});
