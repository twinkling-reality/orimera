/** A factual repository inventory. Status labels describe evidence in the tree, not availability. */

import { el } from './dom.js';

interface Capability {
  readonly name: string;
  readonly boundary: string;
}

interface CapabilityGroup {
  readonly status: string;
  readonly summary: string;
  readonly items: readonly Capability[];
}

export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = Object.freeze([
  {
    status: 'Built and tested',
    summary: 'Executable implementation and repository tests exist for these foundations.',
    items: [
      {
        name: 'Evidence and provenance',
        boundary:
          'Canonical source addresses, content-addressed originals, assertions, tombstones, row-level security, and a provenance ledger.',
      },
      {
        name: 'Photograph intake',
        boundary:
          'Idempotent intake, upright normalization, rendition work, durable queues, bounded retries, and measured worker state.',
      },
      {
        name: 'Vision observation records',
        boundary:
          'Structured, evidence-linked inference rows with model, attempt, cost, and source provenance. Accuracy on a personal corpus is not included in this status.',
      },
      {
        name: 'Adaptive appearance',
        boundary:
          'Versioned profiles with preview, apply, discard, rollback, validation, stale-state recovery, and audit provenance. The upstream conversational proposal service is not built.',
      },
      {
        name: 'World Memory Package',
        boundary:
          'A signed, independently verifiable export with inspect, diff, privacy checks, and deletion re-export. Receiver-side transactional import is intentionally deferred.',
      },
    ],
  },
  {
    status: 'Built, real-world validation pending',
    summary:
      'The development paths exist, but an authorized personal-photo corpus or representative production environment has not supplied the remaining evidence.',
    items: [
      {
        name: 'Semantic memory and Selection',
        boundary:
          'Occurrences, entities, confirmation boundaries, identity proposals, graph snapshots, and validated selection plans. Real-corpus retrieval quality and long-term maintenance remain unmeasured.',
      },
      {
        name: 'Source-first and point-map regions',
        boundary:
          'Source delivery, point-map production, quality gates, artifact provenance, posed multi-map rendering, and visible rung disclosure. Representative real-corpus quality and deployed operation remain unmeasured.',
      },
      {
        name: 'Spatial world runtime',
        boundary:
          'Deterministic composition, stable identities, protected topology, navigation, renderer binding, physical fetch and fallback contracts. Large-world hardware and network envelopes remain unmeasured.',
      },
      {
        name: 'Adaptive interaction',
        boundary:
          'Versioned comfort, navigation, disclosure, and initiative choices with review and rollback. Comprehensibility and longitudinal stability have not been studied with participants.',
      },
      {
        name: 'End-to-end frontier runner',
        boundary:
          'The source-to-package lifecycle is development-exit-gated with generated photographs and a counting model fake. It is not evidence of live-model or real-reconstruction quality.',
      },
    ],
  },
  {
    status: 'Planned',
    summary: 'These product outcomes are specified, but they are not current capabilities.',
    items: [
      {
        name: 'Constrained corridor regions',
        boundary:
          'A bounded route derived from measured poses, clearance, coverage, and navigation artifacts.',
      },
      {
        name: 'Free-walking Gaussian-splat regions',
        boundary:
          'Scene-specific optimization, measured quality gates, compression, navigation proxies, and compatible GPU execution.',
      },
    ],
  },
  {
    status: 'Not deployed',
    summary: 'Repository capability is not the same as a running public service.',
    items: [
      {
        name: 'Hosted Exulanica',
        boundary:
          'Container, health routes, worker separation, and deployment design exist. No cloud account, project, region, domain, registry, production rehearsal, or public service has been provisioned.',
      },
      {
        name: 'Personal-corpus proof',
        boundary:
          'No user-authorized personal library has completed the frontier run, so reconstruction quality, identity-proposal quality, and retrieval quality on personal material are not claimed.',
      },
    ],
  },
]);

function capabilityItem(item: Capability): HTMLElement {
  return el('li', {}, [
    el('strong', { text: item.name }),
    ` — ${item.boundary}`,
  ]);
}

/** What is implemented, what is still being validated, and what does not exist yet. */
export function buildCapabilities(): HTMLElement {
  const root = el('section', {
    id: 'capabilities',
    class: 'pane pane-method pane-capabilities',
    tabindex: '-1',
    'aria-labelledby': 'capabilities-title',
  });
  const inner = el('article', { class: 'prose-column' });

  inner.append(
    el('h1', { class: 'sr-only', id: 'capabilities-title', text: 'Capabilities' }),
    el('p', {
      class: 'prose',
      text: 'These statuses describe the current repository, not a hosted product. “Built” means implementation and executable tests exist; it does not mean the capability has been validated on a personal photograph library.',
    }),
  );

  for (const group of CAPABILITY_GROUPS) {
    const section = el('section', { class: 'capability-group' });
    section.append(
      el('h2', { class: 'prose-head', text: group.status }),
      el('p', { class: 'prose', text: group.summary }),
      el('ul', { class: 'prose capability-list' }, group.items.map(capabilityItem)),
    );
    inner.append(section);
  }

  inner.append(
    el('p', { class: 'prose prose-foot' }, [
      'Status checked against the repository’s ',
      el('a', {
        class: 'inline-link',
        href: 'https://github.com/twinkling-reality/exulanica/blob/main/docs/frontier-roadmap.md',
        rel: 'noreferrer',
        text: 'implementation roadmap',
      }),
      '. The roadmap records the remaining boundary for every item.',
    ]),
  );

  root.append(inner);
  return root;
}
