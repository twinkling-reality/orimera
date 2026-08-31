/**
 * Boot: one session, one snapshot, one scene, and one write path.
 *
 * The shape of this file is the argument. It builds a session, reads the graph once, adapts it
 * into a scene, mounts the renderer, and wires three surfaces to that one snapshot. In a normal
 * build there is no second source of truth and no fixture: everything on the screen came from
 * `GET /graph`, `GET /evidence/{span}` or a write that went through the gate. The Vite development
 * server has one explicit `?preview=1` exception for UI work while the API is unavailable. It is
 * synthetic, identified in the document title and contextual surfaces, and read-only; production
 * builds cannot enter it.
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

import '@orimera/presentation/tokens.css';
import './style.css';
import './appearance.css';

import type { GraphSnapshot, OccurrenceRecord } from '@orimera/graph-client';
import { ApiError } from '@orimera/graph-client';
import { anchorId as toAnchorId, islandId as toIslandId } from '@orimera/atlas-core';
import { confirmationFor, draftEdit } from '@orimera/world-index';
import { mountAtlas, type MountedAtlas } from './atlas.js';
import type { SourceMediaCatalog } from '@orimera/atlas-react/playcanvas';
import {
  applicationTitle,
  credentials,
  developmentToken,
  isAtlasPreview,
  previewCredentials,
} from './config.js';
import { EvidenceCache } from './evidence.js';
import { listBatches, watchBatch, type BatchSummary } from './formation.js';
import { toUpdateProposal } from './proposal.js';
import { buildScene } from './scene.js';
import { openSession, type Session } from './session.js';
import { buildConfirm } from './ui/confirm.js';
import { buildCompanionEncounter } from './ui/companion-encounter.js';
import { resolveCompanionPlacement } from './ui/companion-placement.js';
import { buildAtlasCommands, type AtlasCommand } from './ui/atlas-commands.js';
import { buildControlsGuide } from './ui/controls-guide.js';
import { buildOptions } from './ui/options.js';
import { buildWorldChrome } from './ui/world-chrome.js';
import { buildCompanionStage, type CompanionStage } from './ui/companion-stage.js';
import { createCompanionController } from './companion.js';
import type { CompanionSession, Turn } from '@orimera/companion-runtime';
import { buildDetail } from './ui/detail.js';
import { buildFormation } from './ui/formation.js';
import { el, replace } from './ui/dom.js';
import { buildLibrary } from './ui/library.js';
import { buildStatus, MAP_ORIENTATION_CAPTION } from './ui/status.js';
import { readPreferences, writePreferences, type AtlasPreferences } from './preferences.js';
import {
  InteractionPolicyClient,
  preferencesFromInteractionPolicy,
} from './interaction-policy.js';
import {
  applyDocumentAppearance,
  applyDocumentWorldStyle,
  themeForPreferences,
} from './theme.js';
import { companionAppearanceConfiguration, worldArtProfile } from '@orimera/presentation';
import {
  commandForKeystroke,
  initialWorldShell,
  updateWorldShell,
  type WorldShellEvent,
} from './world-shell.js';

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
let companionEngine: CompanionSession | null = null;
let mountedCompanionStage: CompanionStage | null = null;
let settingsStylePreviewId: string | null = null;
let interactionPolicies: InteractionPolicyClient | null = null;
let previewSourceMedia: SourceMediaCatalog | undefined;
const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');
const systemReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
systemReducedMotion.addEventListener('change', (event) => {
  atlas?.binding.setReducedMotion(event.matches);
});
let preferences = readPreferences(window.localStorage);
applyDocumentAppearance(preferences, systemAppearance.matches);
/**
 * Window listeners belonging to the current mount.
 *
 * `mount` runs again after every committed write and again on a hot reload, and a listener added
 * without one of these survives the mount that added it. Two of them turn one key press into two
 * toggles, which is a summon immediately undone by a dismiss and looks exactly like a key that
 * does nothing.
 */
let mountListeners: AbortController | null = null;
let search = '';
let selected: string | null = null;
/** Monotonic, so two proposals in one session never share an id. Not a clock and not random. */
let issued = 0;
const preview = isAtlasPreview(window.location.search, import.meta.env.DEV);
document.title = applicationTitle(preview);
const previewArtProfileId = preview
  ? new URLSearchParams(window.location.search).get('world-style')
  : null;
const previewArtProfile = previewArtProfileId === null
  ? undefined
  : worldArtProfile(previewArtProfileId);
applyDocumentWorldStyle(previewArtProfile ?? worldArtProfile(
  preferences.worldArtProfile,
  preferences.worldArtProfileVersion,
  preferences.worldStyleParameters,
));

void boot();

async function boot(): Promise<void> {
  if (preview) {
    await start('');
    return;
  }
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
  if (preview) {
    previewSourceMedia = (await import('./dev/preview-media.js')).PREVIEW_SOURCE_MEDIA;
  }
  credentials_ = preview
    ? previewCredentials(window.location.origin)
    : credentials(token);
  const opened = await openSession(credentials_);
  session = opened.session;
  snapshot = opened.initial;
  evidence = new EvidenceCache(opened.session.client);
  companionEngine = opened.companion;
  if (!preview) {
    interactionPolicies = new InteractionPolicyClient(credentials_);
    const interactionState = await interactionPolicies.current();
    if (interactionState.current !== null) {
      preferences = preferencesFromInteractionPolicy(preferences, interactionState.parameters);
      try {
        writePreferences(window.localStorage, preferences);
      } catch {
        // The durable server copy is authoritative; private browsing may reject its local cache.
      }
    }
  }
  await mount();
}

async function mount(): Promise<void> {
  const current = snapshot;
  const currentSession = session;
  const currentEvidence = evidence;
  const currentCredentials = credentials_;
  const currentCompanion = companionEngine;
  if (
    current === null ||
    currentSession === null ||
    currentEvidence === null ||
    currentCredentials === null ||
    currentCompanion === null
  ) {
    return;
  }

  // The turn engine outlives a re-mount, so it is told about the new graph rather than rebuilt.
  // Rebuilding it would discard the memory of what has already been asked, and the Companion
  // would open every refresh by asking the question the user just answered.
  currentCompanion.observeSnapshot(current);

  const built = buildScene(current);
  // A graph write remounts every surface. Stop the previous field before replacing its node, or
  // its frame loop and observers would survive invisibly for the rest of the session.
  mountedCompanionStage?.dispose();
  const stage = el('div', { class: 'stage' });
  const companionStage = buildCompanionStage({ parent: stage });
  const companionAppearance = (): ReturnType<typeof companionAppearanceConfiguration> =>
    companionAppearanceConfiguration({
      body: preferences.companionBody,
      color: preferences.companionColor,
      face: preferences.companionFace,
    });
  companionStage.setAppearance(companionAppearance());
  mountedCompanionStage = companionStage;

  function reflectTurnState(turn: Turn | null): void {
    if (turn === null || turn.intent === 'acknowledge') {
      companionStage.setState('resting');
      return;
    }
    if (turn.intent === 'enrich_relation') {
      companionStage.setState('attending');
      return;
    }
    // Identity, continuity, and contradiction turns all exist because the graph is unresolved.
    companionStage.setState('uncertain');
  }

  const confirm = buildConfirm({
    onConfirm: (proposalId) => void commit(proposalId),
    onCancel: (proposalId) => {
      currentSession.discard(proposalId);
      confirm.hide();
    },
  });

  // The Companion. The controller holds the turn, the panel renders it, and the confirmation
  // surface built above is the only thing either of them can reach that writes.
  const companionController = createCompanionController({
    companion: currentCompanion,
    onAwaitingConfirmation: (proposalId, summary, utterance) => {
      // A staged proposal is still unconfirmed. It may not borrow the settled presentation.
      companionStage.setState('uncertain');
      confirm.show(proposalId, summary, utterance);
    },
  });
  function dismissCompanion(): void {
    companionController.dismiss();
    companionStage.setState('resting');
    companionStage.hide();
    reflectShell();
  }
  const companionPanel = buildCompanionEncounter({
    onSelect: (optionId) => {
      companionController.select(optionId);
      reflectTurnState(companionController.current());
    },
    onSubmit: (optionIds) => {
      companionController.submit(optionIds);
      reflectTurnState(companionController.current());
    },
    onSay: (text) => {
      companionController.say(text);
      reflectTurnState(companionController.current());
    },
    onEvidence: (index) => {
      const handle = companionController.evidenceAt(index);
      if (handle !== null) void currentEvidence.open(handle);
    },
  });
  companionController.attach(companionPanel);

  let shellState = initialWorldShell();
  let reflectShell = (): void => undefined;
  const dispatchShell = (event: WorldShellEvent): void => {
    shellState = updateWorldShell(shellState, event);
    reflectShell();
  };

  const travelStatus = el('p', {
    class: 'travel-status',
    role: 'status',
    'aria-live': 'polite',
  });
  travelStatus.hidden = true;
  let travelStatusTimer: number | null = null;
  const showTravelStatus = (message: string, kind: 'progress' | 'failure' = 'progress'): void => {
    if (travelStatusTimer !== null) window.clearTimeout(travelStatusTimer);
    travelStatus.textContent = message;
    travelStatus.dataset['kind'] = kind;
    travelStatus.hidden = false;
    travelStatusTimer = window.setTimeout(() => {
      travelStatus.hidden = true;
      travelStatusTimer = null;
    }, kind === 'failure' ? 5200 : 3200);
  };
  const travelUsesReducedMotion = (): boolean =>
    preferences.transition === 'fade' ||
    (preferences.transition === 'system' && systemReducedMotion.matches);

  const detail = buildDetail(currentEvidence, {
    onClose: () => dispatchShell({ type: 'close-detail' }),
    onName: (occurrence) => propose(occurrence, confirm),
    onEvidenceOpened: (anchorId) => {
      // 5.2: the written claim and the spatial world point at the same evidence at the same
      // moment. Focusing the anchor is the spatial half of that one gesture.
      if (anchorId === null || atlas === null) return;
      const index = atlas.binding.table.indexOf.get(anchorId as never);
      if (index !== undefined) atlas.binding.focusAnchor(index);
    },
    onLocate: (targetAnchorId, targetIslandId) => {
      const binding = atlas?.binding;
      if (binding === undefined) {
        showTravelStatus('The Atlas is still forming. Try again in a moment.', 'failure');
        return;
      }
      const resolution = targetAnchorId === null
        ? binding.navigateToIsland(toIslandId(targetIslandId), travelUsesReducedMotion())
        : binding.navigateToAnchor(toAnchorId(targetAnchorId), travelUsesReducedMotion());
      if (!resolution.ok) {
        const message = {
          'unknown-target': 'That source is not in this Atlas.',
          'outside-resident-field': 'That region is outside the resident field.',
          'no-safe-surface': 'No safe arrival point is available near that source. Open Map to approach its region.',
          occluded: 'That source is present, but no clear arrival point is available.',
        }[resolution.reason];
        showTravelStatus(message, 'failure');
        return;
      }
      dispatchShell({ type: 'show-world' });
      showTravelStatus(travelUsesReducedMotion() ? 'Located the source.' : 'Moving to the source…');
    },
  }, {
    preview,
    ...(previewSourceMedia === undefined ? {} : { sourceMedia: previewSourceMedia }),
  });

  const library = buildLibrary({
    onEntity: (entityId) => {
      selected = entityId;
      const entity = current.entities.find((e) => e.entityId === entityId);
      if (entity !== undefined) {
        detail.showEntity(current, entity);
        dispatchShell({ type: 'show-detail', id: entityId });
      }
      library.render(current, search, selected);
    },
    onOccurrence: (occurrenceId) => {
      selected = occurrenceId;
      const occurrence = current.occurrences.find((o) => o.occurrenceId === occurrenceId);
      if (occurrence !== undefined) {
        detail.showOccurrence(occurrence);
        dispatchShell({ type: 'show-detail', id: occurrenceId });
      }
      library.render(current, search, selected);
    },
    onSearch: (text) => {
      search = text;
      library.render(current, search, selected);
    },
  }, { preview });

  // The canvas stays where the document put it: fixed, behind everything, outside the shell.
  // Moving it into the shell would put it in the shell's stacking context, where it paints over
  // the rail. The stage is the hole it shows through and the parent the anchor overlay writes
  // its nodes into, which is a different job from being the canvas.
  const forming = buildFormation();
  const chrome = buildWorldChrome(shell!);
  const handleAtlasCommand = (command: AtlasCommand): void => {
    if (companionPanel.state() === 'open') dismissCompanion();
    if (command === 'index') dispatchShell({ type: 'toggle-index' });
    else if (command === 'map') dispatchShell({ type: 'toggle-map' });
    else if (command === 'options') dispatchShell({ type: 'toggle-options' });
    else dispatchShell({ type: 'toggle-controls' });
  };
  const commandBar = buildAtlasCommands(handleAtlasCommand);
  const mapCaption = el('p', {
    class: 'map-caption',
    text: `Atlas Map · ${MAP_ORIENTATION_CAPTION} · M to return to ground view`,
  });
  mapCaption.hidden = true;
  const viewportBoundary = el('aside', {
    class: 'viewport-boundary',
    'aria-labelledby': 'viewport-boundary-title',
  }, [
    el('p', { class: 'overlay-kicker', text: 'Atlas boundary' }),
    el('h1', { id: 'viewport-boundary-title', text: 'A wider view is required' }),
    el('p', {
      text:
        'This Atlas prototype is designed for laptop and desktop windows. ' +
        'Widen this window to at least 60rem to continue.',
    }),
  ]);
  const optionsView = buildOptions({
    preferences,
    onChange: applyPreferences,
    onPreview: (candidate) => {
      shell!.setAttribute('data-vignette', candidate.vignette);
      atlas?.binding.setFieldOfView(candidate.fieldOfView);
      atlas?.binding.setSensitivityMultiplier(candidate.mouseSensitivity);
      if (atlas === null) return;
      const styleChanged = candidate.worldArtProfile !== preferences.worldArtProfile ||
        JSON.stringify(candidate.worldStyleParameters) !==
          JSON.stringify(preferences.worldStyleParameters);
      if (!styleChanged) return;
      if (settingsStylePreviewId !== null) {
        atlas.binding.discardArtProfilePreview(settingsStylePreviewId);
        settingsStylePreviewId = null;
      }
      const candidateProfile = worldArtProfile(
        candidate.worldArtProfile,
        candidate.worldArtProfileVersion,
        candidate.worldStyleParameters,
      );
      const previewSession = atlas.binding.previewArtProfile(
        candidateProfile,
        'settings',
        candidate.worldStyleParameters,
      );
      if (previewSession.validation.ok) {
        settingsStylePreviewId = previewSession.sessionId;
        applyDocumentWorldStyle(candidateProfile);
      }
    },
    onWorldDiscard: (restored) => {
      if (settingsStylePreviewId !== null && atlas !== null) {
        atlas.binding.discardArtProfilePreview(settingsStylePreviewId);
        settingsStylePreviewId = null;
      }
      applyDocumentWorldStyle(previewArtProfile ?? worldArtProfile(
        restored.worldArtProfile,
        restored.worldArtProfileVersion,
        restored.worldStyleParameters,
      ));
    },
    onClose: () => dispatchShell({ type: 'toggle-options' }),
    onShowControls: () => dispatchShell({ type: 'toggle-controls' }),
  });
  const controlsGuide = buildControlsGuide({
    onClose: () => dispatchShell({ type: 'toggle-controls' }),
    onShowOptions: () => dispatchShell({ type: 'toggle-options' }),
  });

  let latestSettingsSave = 0;
  function applyPreferences(next: AtlasPreferences): void {
    const previous = preferences;
    preferences = next;
    if (settingsStylePreviewId !== null && atlas !== null) {
      atlas.binding.discardArtProfilePreview(settingsStylePreviewId);
      settingsStylePreviewId = null;
    }
    try {
      writePreferences(window.localStorage, preferences);
    } catch {
      // Private browsing may refuse storage. The live setting still applies for this session.
    }
    const theme = applyDocumentAppearance(preferences, systemAppearance.matches);
    const profile = previewArtProfile ?? worldArtProfile(
      preferences.worldArtProfile,
      preferences.worldArtProfileVersion,
      preferences.worldStyleParameters,
    );
    applyDocumentWorldStyle(profile);
    optionsView.setPreferences(preferences);
    companionStage.setAppearance(companionAppearance());
    shell!.setAttribute('data-vignette', preferences.vignette);
    atlas?.binding.setTheme(theme);
    atlas?.binding.setArtProfile(
      profile,
      'settings',
      preferences.worldStyleParameters,
    );
    atlas?.binding.setFieldOfView(preferences.fieldOfView);
    atlas?.binding.setSensitivityMultiplier(preferences.mouseSensitivity);
    if (interactionPolicies !== null) {
      latestSettingsSave += 1;
      const save = latestSettingsSave;
      optionsView.reportPersistence('saving');
      void interactionPolicies
        .syncSettings(previous, preferences, systemReducedMotion.matches)
        .then(() => {
          if (save === latestSettingsSave) optionsView.reportPersistence('saved');
        })
        .catch(() => {
          if (save === latestSettingsSave) optionsView.reportPersistence('failed');
        });
    }
  }

  replace(shell!, [
    stage,
    chrome.reticle,
    library.root,
    detail.root,
    forming.root,
    companionPanel.root,
    confirm.root,
    commandBar.root,
    mapCaption,
    travelStatus,
    optionsView.root,
    controlsGuide.root,
    viewportBoundary,
    buildStatus({
      omittedRegionCount: built.omitted.length,
      undrawable: built.undrawable,
    }),
  ]);

  reflectShell = (): void => {
    shell!.setAttribute('data-primary', shellState.primary);
    shell!.setAttribute('data-camera', shellState.camera);
    chrome.setIndexOpen(shellState.primary === 'index');
    library.root.inert = shellState.primary !== 'index';
    library.root.setAttribute('aria-hidden', shellState.primary === 'index' ? 'false' : 'true');
    optionsView.setVisible(shellState.primary === 'options');
    controlsGuide.setVisible(shellState.primary === 'controls');
    const systemSurfaceOpen = shellState.primary === 'options' || shellState.primary === 'controls';
    for (const surface of [
      stage,
      library.root,
      detail.root,
      forming.root,
      companionPanel.root,
      confirm.root,
      commandBar.root,
      mapCaption,
      travelStatus,
    ]) {
      surface.inert = systemSurfaceOpen;
    }
    commandBar.reflect(shellState.primary, shellState.camera);
    mapCaption.hidden = shellState.camera !== 'map';
    detail.root.hidden = shellState.primary !== 'index' || shellState.detailId === null;
    atlas?.binding.setMapMode(shellState.camera === 'map');
    atlas?.binding.setControlsEnabled(
      !systemSurfaceOpen &&
      shellState.camera === 'ground',
    );
    atlas?.binding.setCompanionConversationActive(companionPanel.state() === 'open');
    if (
      (shellState.primary !== 'world' || shellState.camera === 'map') &&
      document.pointerLockElement !== null
    ) {
      document.exitPointerLock();
    }
  };
  shell!.setAttribute('data-vignette', preferences.vignette);
  reflectShell();

  library.render(current, search, selected);
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
  settingsStylePreviewId = null;
  const activeTheme = themeForPreferences(preferences, systemAppearance.matches);
  let lastMoving: boolean | null = null;
  atlas = await mountAtlas(canvas as HTMLCanvasElement, stage, built.scene, (report) => {
    if (lastMoving !== report.moving) {
      lastMoving = report.moving;
      shell!.setAttribute('data-moving', report.moving ? 'true' : 'false');
    }
    shell!.setAttribute('data-spatial', report.spatial.phase);
    if (report.recoveryReason !== null) {
      showTravelStatus(
        report.recoveryReason === 'outside-field'
          ? 'Returned to the nearest safe place; the resident field ended here.'
          : report.recoveryReason === 'no-surface'
            ? 'Returned to the nearest safe place; there is no walkable surface here.'
            : 'Returned to the nearest safe place; the surface ahead is too steep or discontinuous.',
        'failure',
      );
    }
  }, {
    theme: activeTheme,
    fieldOfView: preferences.fieldOfView,
    mouseSensitivity: preferences.mouseSensitivity,
    artProfile: previewArtProfile ?? worldArtProfile(
      preferences.worldArtProfile,
      preferences.worldArtProfileVersion,
      preferences.worldStyleParameters,
    ),
    ...(previewArtProfile === undefined
      ? { artProfileParameters: preferences.worldStyleParameters }
      : {}),
    ...(previewSourceMedia === undefined ? {} : { sourceMedia: previewSourceMedia }),
    reducedMotion: systemReducedMotion.matches,
  });
  (canvas as HTMLCanvasElement).dataset.companionRenderer = 'svg';
  reflectShell();

  // -- the two input modes, and the one key that calls the Companion ----------------------
  //
  // The mode follows the browser's pointer lock state and is never guessed at: the browser drops
  // the lock on Escape and on focus loss without telling the application first, so a mode the
  // application tracked itself would be wrong within seconds of the user tabbing away.
  const mounted = atlas;
  mounted.binding.mapOverlay?.setActive(shellState.camera === 'map');
  mounted.binding.onMapTarget = (islandId) => {
    const resolution = mounted.binding.navigateToIsland(islandId, travelUsesReducedMotion());
    if (!resolution.ok) {
      showTravelStatus('No safe arrival point is available in that region.', 'failure');
      return;
    }
    dispatchShell({ type: 'show-world' });
    showTravelStatus(travelUsesReducedMotion() ? 'Located the region.' : 'Moving to the region…');
  };
  mounted.binding.onNavigationArrive = (target) => {
    if (target.kind === 'anchor') {
      const index = mounted.binding.table.indexOf.get(target.anchorId);
      if (index !== undefined) mounted.binding.focusAnchor(index);
    }
    showTravelStatus(target.kind === 'anchor' ? 'Located the source.' : 'The memory is in focus.');
  };
  function reflectMode(next: 'traverse' | 'converse'): void {
    chrome.setMode(next);
    if (next === 'traverse' && (shellState.primary !== 'world' || shellState.camera !== 'ground')) {
      dispatchShell({ type: 'show-world' });
    }
    // The prompt says what is true right now. With the mouse free the useful instruction is how
    // to get into the world; once inside it is how to call the Companion. An open conversation
    // outranks both and is left alone.
    if (companionPanel.state() === 'open') return;
    companionPanel.setState(next === 'traverse' ? 'summon' : 'enter');
  }
  mounted.binding.controls.onModeChange = reflectMode;
  reflectMode(mounted.binding.controls.mode);

  /** Open the fixed visual-novel composition over the current memory backdrop. */
  // X and right click reach this through the renderer controls, so the verb observes the same
  // enabled/disabled boundary as movement and interaction instead of bypassing system surfaces.
  function summonCompanion(): void {
    // Pointer Lock freezes clientX/clientY by specification. The SVG Companion follows the free
    // page pointer, so summoning releases the real browser lock instead of fabricating a cursor.
    if (document.pointerLockElement !== null) document.exitPointerLock();
    const placement = resolveCompanionPlacement({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      // The reference deliberately treats the memory as backdrop, so it does not mirror the
      // reading order around a projected source rectangle.
      memoryBounds: null,
      preferredSide: preferences.companionSide,
    });
    companionPanel.setPlacement(placement);
    companionController.summon(Date.now());
    reflectTurnState(companionController.current());
    companionStage.show();
    reflectShell();
  }

  function toggleCompanion(): void {
    if (companionPanel.state() === 'open') {
      dismissCompanion();
      return;
    }
    summonCompanion();
  }

  mounted.binding.controls.onSummon = toggleCompanion;

  mountListeners?.abort();
  mountListeners = new AbortController();
  (canvas as HTMLCanvasElement).addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      dispatchShell({ type: 'show-index' });
      showTravelStatus(
        'The 3D renderer became unavailable. The complete World Index remains available.',
        'failure',
      );
    },
    { signal: mountListeners.signal },
  );
  window.addEventListener(
    'keydown',
    (event) => {
      const target = event.target;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      // Pointer lock is already released while the Companion is open, so Escape has no browser
      // navigation job left to do in this state. It dismisses the whole exchange, including while
      // a custom reply is focused. While locked, Controls still leaves Escape entirely to the
      // browser and this branch cannot be reached because an open Companion disables traversal.
      if (
        event.code === 'Escape' &&
        companionPanel.state() === 'open' &&
        document.pointerLockElement === null
      ) {
        event.preventDefault();
        dismissCompanion();
        return;
      }
      const command = commandForKeystroke({
        code: event.code,
        key: event.key,
        modified: event.altKey || event.ctrlKey || event.metaKey,
        typing,
      });
      if (command === 'toggle-index') {
        event.preventDefault();
        handleAtlasCommand('index');
        return;
      }
      if (command === 'toggle-map') {
        event.preventDefault();
        handleAtlasCommand('map');
        return;
      }
      if (command === 'toggle-options') {
        event.preventDefault();
        handleAtlasCommand('options');
        return;
      }
      if (command === 'toggle-controls') {
        event.preventDefault();
        handleAtlasCommand('controls');
        return;
      }
      if (command === 'selection-back' && shellState.detailId !== null) {
        event.preventDefault();
        dispatchShell({ type: 'close-detail' });
        return;
      }
      // Not while the user is typing an answer into the Companion or a name into the index.
      if (typing) return;
      // Answering by number, which is the only way to answer while the pointer is locked: there
      // is no cursor to click with, and releasing the lock to reply would mean leaving the world
      // for every question. Unavailable options return null and the key does nothing, rather than
      // selecting the next one along and committing something nobody chose.
      if (/^Digit[1-9]$/.test(event.code)) {
        if (companionPanel.pressNumber(Number(event.code.slice(5)))) event.preventDefault();
        return;
      }
    },
    { signal: mountListeners.signal },
  );
  systemAppearance.addEventListener(
    'change',
    () => applyPreferences(preferences),
    { signal: mountListeners.signal },
  );

  // Nothing is asked unprompted. The Companion arrives when it is called, and until then the
  // world is the whole of what is on screen.

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
    if (preview) {
      companionStage.setState('uncertain');
      confirm.reportFailure('Preview mode is read-only. No change was sent.');
      return;
    }
    // This state names a real pending write. It begins before the request and ends with its result.
    companionStage.setState('working');
    try {
      await currentSession!.commit(proposalId);
    } catch (error) {
      companionStage.setState('uncertain');
      panelFailure(confirm, error);
      return;
    }
    // Only a completed account-holder confirmation earns this state.
    companionStage.setState('settled');
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
