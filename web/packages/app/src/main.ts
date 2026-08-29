/**
 * Boot: one session, one snapshot, one scene, and one write path.
 *
 * The shape of this file is the argument. It builds a session, reads the graph once, adapts it
 * into a scene, mounts the renderer, and wires three surfaces to that one snapshot. There is no
 * second source of truth and no fixture: everything on the screen came from `GET /graph`,
 * `GET /evidence/{span}` or a write that went through the gate.
 *
 * **Every write goes through the confirmation surface**, and the confirmation surface is the only
 * caller of `session.commit`. The chain is: the user types a name, a draft is built by
 * `world-index`, translated into an update proposal, staged on the gate, rendered for reading,
 * and committed only when the user presses confirm. Skipping any link is not possible from here,
 * because `session` exposes `stage` and `commit` separately and the panel is what sits between.
 *
 * **The snapshot is re-read after a write rather than patched.** A local patch would be a second
 * model of the graph maintained by hand, and the first time it disagreed with the server the
 * interface would be confidently wrong. Re-reading costs one request and cannot drift.
 */

import './style.css';

import type { GraphSnapshot, OccurrenceRecord } from '@orimera/graph-client';
import { ApiError } from '@orimera/graph-client';
import { confirmationFor, draftEdit } from '@orimera/world-index';
import { mountAtlas, type MountedAtlas } from './atlas.js';
import { credentials, developmentToken } from './config.js';
import { EvidenceCache } from './evidence.js';
import { listBatches, watchBatch, type BatchSummary } from './formation.js';
import { toUpdateProposal } from './proposal.js';
import { NO_GEOMETRY_RUNG, buildScene } from './scene.js';
import { openSession, type Session } from './session.js';
import { buildConfirm } from './ui/confirm.js';
import { buildDetail } from './ui/detail.js';
import { buildFormation } from './ui/formation.js';
import { el, replace } from './ui/dom.js';
import { buildLibrary } from './ui/library.js';
import { buildStatus } from './ui/status.js';

const shell = document.getElementById('shell');
const canvas = document.getElementById('atlas');
if (!(canvas instanceof HTMLCanvasElement) || shell === null) {
  throw new Error('app: expected #atlas and #shell in the document');
}

let credentials_: { baseUrl: string; token: string } | null = null;
let session: Session | null = null;
let stopWatching: (() => void) | null = null;
let snapshot: GraphSnapshot | null = null;
let atlas: MountedAtlas | null = null;
let evidence: EvidenceCache | null = null;
let search = '';
let selected: string | null = null;
/** Monotonic, so two proposals in one session never share an id. Not a clock and not random. */
let issued = 0;

void boot();

async function boot(): Promise<void> {
  const token = developmentToken();
  if (token === null) {
    askForToken();
    return;
  }
  await start(token);
}

/**
 * The credential prompt.
 *
 * There is no account system to sign in to. `orimera/api/authorisation.py` says so plainly, and
 * this asks for the bearer token the operator configured rather than inventing a registration
 * flow a config module has no business deciding. Nothing is stored: the value goes to the
 * transport and is not written to storage, a cookie or the URL.
 */
function askForToken(): void {
  const form = el('form', { class: 'gate' });
  const input = el('input', {
    type: 'password',
    autocomplete: 'off',
    'aria-label': 'Access token',
    placeholder: 'Access token',
  });
  const failure = el('p', { class: 'gate-failure' });
  failure.hidden = true;

  form.append(
    el('h1', { text: 'Orimera' }),
    el('p', { class: 'gate-note' }, [
      'This instance authenticates with a bearer token the operator configures. There is no ' +
        'account system, no registration and no password reset. The token is held for this tab ' +
        'only and is never stored.',
    ]),
    input,
    el('button', { type: 'submit', class: 'primary', text: 'Open the library' }),
    failure,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    failure.hidden = true;
    void start(input.value.trim()).catch((error: unknown) => {
      failure.hidden = false;
      failure.textContent =
        error instanceof ApiError && error.isUnauthenticated
          ? 'That token is not configured on this instance.'
          : error instanceof Error
            ? error.message
            : 'the request failed';
    });
  });
  replace(shell!, [form]);
  input.focus();
}

async function start(token: string): Promise<void> {
  credentials_ = credentials(token);
  const opened = await openSession(credentials_);
  session = opened.session;
  snapshot = opened.initial;
  evidence = new EvidenceCache(opened.session.client);
  await mount();
}

async function mount(): Promise<void> {
  const current = snapshot;
  const currentSession = session;
  const currentEvidence = evidence;
  const currentCredentials = credentials_;
  if (
    current === null ||
    currentSession === null ||
    currentEvidence === null ||
    currentCredentials === null
  ) {
    return;
  }

  const built = buildScene(current);

  const confirm = buildConfirm({
    onConfirm: (proposalId) => void commit(proposalId),
    onCancel: (proposalId) => {
      currentSession.discard(proposalId);
      confirm.hide();
    },
  });

  const detail = buildDetail(currentEvidence, {
    onName: (occurrence) => propose(occurrence, confirm),
    onEvidenceOpened: (anchorId) => {
      // 5.2: the written claim and the spatial world point at the same evidence at the same
      // moment. Focusing the anchor is the spatial half of that one gesture.
      if (anchorId === null || atlas === null) return;
      const index = atlas.binding.table.indexOf.get(anchorId as never);
      if (index !== undefined) atlas.binding.focusAnchor(index);
    },
  });

  const library = buildLibrary({
    onEntity: (entityId) => {
      selected = entityId;
      const entity = current.entities.find((e) => e.entityId === entityId);
      if (entity !== undefined) detail.showEntity(current, entity);
      library.render(current, search, selected);
    },
    onOccurrence: (occurrenceId) => {
      selected = occurrenceId;
      const occurrence = current.occurrences.find((o) => o.occurrenceId === occurrenceId);
      if (occurrence !== undefined) detail.showOccurrence(occurrence);
      library.render(current, search, selected);
    },
    onSearch: (text) => {
      search = text;
      library.render(current, search, selected);
    },
  });

  // The canvas stays where the document put it: fixed, behind everything, outside the shell.
  // Moving it into the shell would put it in the shell's stacking context, where it paints over
  // the rail. The stage is the hole it shows through and the parent the anchor overlay writes
  // its nodes into, which is a different job from being the canvas.
  const forming = buildFormation();
  const stage = el('div', { class: 'stage' });
  replace(shell!, [
    library.root,
    stage,
    detail.root,
    forming.root,
    confirm.root,
    buildStatus({
      snapshot: current,
      regionCount: built.scene.islands.length,
      rung: NO_GEOMETRY_RUNG,
      omittedRegionCount: built.omitted.length,
      undrawable: built.undrawable,
    }),
  ]);

  library.render(current, search, selected);
  detail.showNothing();
  forming.render(null, null);

  // What there is to watch. There is no upload endpoint yet, so an intake starts from the command
  // line and this asks the API rather than assuming: an empty list renders as nothing forming,
  // which is a true statement, and a fabricated batch would not be.
  stopWatching?.();
  stopWatching = null;
  void listBatches(currentCredentials!).then((batches) => {
    const watching = mostRecentlyStarted(batches);
    if (watching === undefined) return;
    stopWatching = watchBatch(currentCredentials!, watching.batchId, (state) => {
      forming.render(state, watching.label);
    });
  });

  atlas?.dispose();
  atlas = await mountAtlas(canvas as HTMLCanvasElement, stage, built.scene);

  // Reported rather than trusted. A placement that does not reproduce atlas-core's own transform
  // is a region turned the wrong way, which is invisible until somebody walks behind it.
  const worst = Math.max(0, ...atlas.placements.map((check) => check.maxErrorMetres));
  if (worst > 1e-3) {
    console.warn(`atlas placement disagrees with atlas-core by ${worst} atlas units`);
  }

  // -- the write path, in full -----------------------------------------------------------
  function propose(occurrence: OccurrenceRecord, panel: typeof confirm): void {
    const form = detail.root.querySelector<HTMLFormElement>('.name-offer');
    const input = form?.querySelector<HTMLInputElement>('input');
    const displayName = input?.value.trim() ?? '';
    if (displayName.length === 0) return;

    issued += 1;
    const proposalId = `proposal-${issued}`;
    // Drafted by world-index, not here. The tier, the reversibility and the four bands all come
    // from the one policy table both surfaces obey.
    const draft = draftEdit(
      current!,
      syntheticEntityFor(occurrence),
      displayName,
      (kind) => `${kind}-${issued}`,
    );
    const translated = toUpdateProposal(draft, {
      proposalId,
      turnId: `turn-${issued}`,
      stateVersion: currentSession!.stateVersion(),
      occurrenceId: occurrence.occurrenceId,
    });
    if (!translated.ok) {
      panel.reportFailure(translated.reason);
      return;
    }
    currentSession!.stage(translated.proposal);
    panel.show(proposalId, confirmationFor(draft, syntheticEntityFor(occurrence)), displayName);
  }

  async function commit(proposalId: string): Promise<void> {
    try {
      await currentSession!.commit(proposalId);
    } catch (error) {
      panelFailure(confirm, error);
      return;
    }
    confirm.hide();
    // Re-read rather than patched. See the module comment.
    snapshot = await currentSession!.snapshot();
    selected = null;
    await mount();
  }
}

function panelFailure(confirm: ReturnType<typeof buildConfirm>, error: unknown): void {
  confirm.reportFailure(
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'the write was refused',
  );
}

/**
 * The entity a bare occurrence would become.
 *
 * `draftEdit` and `confirmationFor` both take an `EntityRecord`, because both were written for
 * the case where the thing already exists. Naming a detection creates the entity, so there is no
 * record to hand them yet. This builds the one the write is about to produce: no name, no
 * assertions, and the occurrence's own island. Every field is either the truth or empty, and
 * nothing here is written anywhere: it exists to be described in the confirmation panel and is
 * discarded afterwards.
 */
function syntheticEntityFor(occurrence: OccurrenceRecord) {
  return {
    entityId: occurrence.entityId ?? occurrence.occurrenceId,
    kind: occurrence.kind === 'voice' || occurrence.kind === 'conversation'
      ? ('object' as const)
      : (occurrence.kind as 'person' | 'place' | 'object' | 'event'),
    displayName: null,
    status: 'inferred_only' as const,
    occurrenceCount: 1,
    islandIds: [occurrence.islandId],
    firstSeenMs: occurrence.capturedAtMs,
    lastSeenMs: occurrence.capturedAtMs,
    confidence: occurrence.confidence,
    openQuestionCount: 0,
    citingAnswerCount: 0,
    assertions: [],
    relations: [],
    contradictions: [],
    history: [],
    mergedInto: null,
  };
}


/**
 * The batch to watch, or none.
 *
 * The most recently started one, running or not. A finished batch replays its history and ends,
 * which is the same code path a live subscriber takes, so somebody who opens the page after an
 * ingest finished reads what happened rather than finding nothing and concluding it was lost.
 */
function mostRecentlyStarted(batches: readonly BatchSummary[]): BatchSummary | undefined {
  return [...batches].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
