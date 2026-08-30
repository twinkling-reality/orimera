import type { IslandId } from '../ids.js';

export type WorldProposalOrigin = 'settings' | 'companion';
export type WorldProposalKind = 'appearance' | 'structural';
export type WorldProposalScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'region'; readonly islandId: IslandId };

export type WorldStyleParameterValue = number | string | boolean;

interface WorldStyleParameterBase {
  /** Stable manifest-local key. Renderer bindings use capability, never the display label. */
  readonly key: string;
  /** Renderer capability from the trusted capability registry. */
  readonly capability: string;
  readonly label: string;
  readonly description: string;
  readonly group: 'world' | 'material' | 'atmosphere' | 'motion' | 'detail';
}

export type WorldStyleParameterDefinition =
  | (WorldStyleParameterBase & {
      readonly kind: 'range';
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly defaultValue: number;
    })
  | (WorldStyleParameterBase & {
      readonly kind: 'choice';
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly defaultValue: string;
    })
  | (WorldStyleParameterBase & {
      readonly kind: 'color';
      readonly defaultValue: string;
    })
  | (WorldStyleParameterBase & {
      readonly kind: 'toggle';
      readonly defaultValue: boolean;
    });

export interface WorldStyleReference {
  readonly profileId: string;
  readonly profileVersion: number;
  /** Complete, validated values after catalog resolution; proposals may provide a sparse subset. */
  readonly parameters?: Readonly<Record<string, WorldStyleParameterValue>>;
}

export interface WorldStyleDescriptor extends WorldStyleReference {
  readonly displayName: string;
  readonly description?: string;
  readonly controls?: readonly WorldStyleParameterDefinition[];
}

export interface WorldStyleCatalog {
  readonly defaultProfile: WorldStyleReference;
  readonly profiles: readonly WorldStyleDescriptor[];
}

export interface WorldAppearanceProposal {
  readonly proposalId: string;
  readonly origin: WorldProposalOrigin;
  readonly kind: 'appearance';
  readonly scope: WorldProposalScope;
  readonly baseStyleVersionId: string;
  readonly baseTopologyDigest: string;
  readonly profile: WorldStyleReference;
}

export interface WorldStructuralProposal {
  readonly proposalId: string;
  readonly origin: WorldProposalOrigin;
  readonly kind: 'structural';
  readonly scope: WorldProposalScope;
  readonly baseStyleVersionId: string;
  readonly baseTopologyDigest: string;
  readonly operation:
    | { readonly kind: 'move-region'; readonly islandId: IslandId }
    | { readonly kind: 'replace-module'; readonly instanceId: string; readonly moduleKey: string }
    | { readonly kind: 'change-neighborhood'; readonly islandId: IslandId };
}

export type WorldCustomizationProposal = WorldAppearanceProposal | WorldStructuralProposal;

export interface WorldRegionStyleOverride extends WorldStyleReference {
  readonly islandId: IslandId;
}

export interface WorldStyleVersion {
  readonly versionId: string;
  readonly revision: number;
  readonly parentVersionId: string | null;
  readonly global: WorldStyleReference;
  readonly regions: readonly WorldRegionStyleOverride[];
  readonly appliedFromProposalId: string | null;
}

export type WorldProposalIssueCode =
  | 'stale-style-version'
  | 'topology-changed'
  | 'unknown-style-profile'
  | 'unknown-style-parameter'
  | 'invalid-style-parameter'
  | 'unknown-region'
  | 'structural-preview-unavailable';

export interface WorldProposalIssue {
  readonly code: WorldProposalIssueCode;
  readonly detail: string;
  readonly protectedValue: boolean;
}

export interface WorldProposalValidation {
  readonly ok: boolean;
  readonly issues: readonly WorldProposalIssue[];
}

export interface WorldPreviewSession {
  readonly sessionId: string;
  readonly proposal: WorldCustomizationProposal;
  readonly validation: WorldProposalValidation;
  readonly candidate: WorldStyleVersion | null;
  readonly topologyDigest: string;
}

export interface WorldStyleResolution {
  readonly version: WorldStyleVersion;
  readonly warnings: readonly string[];
}

const freezeReference = (value: WorldStyleReference): WorldStyleReference => Object.freeze({
  profileId: value.profileId,
  profileVersion: value.profileVersion,
  ...(value.parameters === undefined
    ? {}
    : { parameters: Object.freeze({ ...value.parameters }) }),
});

const profileKey = (value: WorldStyleReference): string =>
  `${value.profileId}@${value.profileVersion}`;

function catalogProfiles(catalog: WorldStyleCatalog): ReadonlyMap<string, WorldStyleDescriptor> {
  const profiles = new Map<string, WorldStyleDescriptor>();
  for (const profile of catalog.profiles) {
    if (profile.profileId.length === 0 || profile.displayName.length === 0) {
      throw new TypeError('world style profiles require stable IDs and display names');
    }
    if (!Number.isSafeInteger(profile.profileVersion) || profile.profileVersion < 1) {
      throw new TypeError(`invalid world style profile version: ${profile.profileId}`);
    }
    const key = profileKey(profile);
    if (profiles.has(key)) throw new TypeError(`duplicate world style profile: ${key}`);
    const seenControls = new Set<string>();
    const controls = (profile.controls ?? []).map((control) => {
      if (!/^[a-z][a-z0-9.-]*$/.test(control.key)) {
        throw new TypeError(`invalid world style parameter key: ${control.key}`);
      }
      if (seenControls.has(control.key)) {
        throw new TypeError(`duplicate world style parameter: ${profile.profileId}.${control.key}`);
      }
      if (control.capability.length === 0 || control.label.length === 0 || control.description.length === 0) {
        throw new TypeError(`world style parameter metadata is incomplete: ${profile.profileId}.${control.key}`);
      }
      seenControls.add(control.key);
      if (control.kind === 'range') {
        if (
          !Number.isFinite(control.min) || !Number.isFinite(control.max) ||
          !Number.isFinite(control.step) || !Number.isFinite(control.defaultValue) ||
          control.min >= control.max || control.step <= 0 ||
          control.defaultValue < control.min || control.defaultValue > control.max
        ) throw new TypeError(`invalid world style range: ${profile.profileId}.${control.key}`);
      } else if (control.kind === 'choice') {
        const values = new Set(control.options.map((option) => option.value));
        if (
          values.size !== control.options.length || control.options.length < 2 ||
          !values.has(control.defaultValue) ||
          control.options.some((option) => option.value.length === 0 || option.label.length === 0)
        ) throw new TypeError(`invalid world style choice: ${profile.profileId}.${control.key}`);
      } else if (control.kind === 'color' && !/^#[0-9a-f]{6}$/i.test(control.defaultValue)) {
        throw new TypeError(`invalid world style color: ${profile.profileId}.${control.key}`);
      }
      return Object.freeze({
        ...control,
        ...(control.kind === 'choice'
          ? { options: Object.freeze(control.options.map((option) => Object.freeze({ ...option }))) }
          : {}),
      }) as WorldStyleParameterDefinition;
    });
    profiles.set(key, Object.freeze({
      ...profile,
      ...(controls.length === 0 ? {} : { controls: Object.freeze(controls) }),
      ...(profile.parameters === undefined
        ? {}
        : { parameters: Object.freeze({ ...profile.parameters }) }),
    }));
  }
  if (!profiles.has(profileKey(catalog.defaultProfile))) {
    throw new TypeError('default world style profile is missing from the catalog');
  }
  return profiles;
}

function parameterIssue(
  descriptor: WorldStyleDescriptor,
  reference: WorldStyleReference,
): WorldProposalIssue[] {
  const definitions = new Map((descriptor.controls ?? []).map((control) => [control.key, control] as const));
  const issues: WorldProposalIssue[] = [];
  for (const [key, value] of Object.entries(reference.parameters ?? {})) {
    const definition = definitions.get(key);
    if (definition === undefined) {
      issues.push(Object.freeze({
        code: 'unknown-style-parameter',
        detail: `Unknown parameter ${key} for ${profileKey(descriptor)}.`,
        protectedValue: false,
      }));
      continue;
    }
    const valid = definition.kind === 'range'
      ? typeof value === 'number' && Number.isFinite(value) && value >= definition.min && value <= definition.max
      : definition.kind === 'choice'
        ? typeof value === 'string' && definition.options.some((option) => option.value === value)
        : definition.kind === 'color'
          ? typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
          : typeof value === 'boolean';
    if (!valid) issues.push(Object.freeze({
      code: 'invalid-style-parameter',
      detail: `Invalid value for ${key} on ${profileKey(descriptor)}.`,
      protectedValue: false,
    }));
  }
  return issues;
}

function resolveReference(
  reference: WorldStyleReference,
  descriptor: WorldStyleDescriptor,
): WorldStyleReference {
  const controls = descriptor.controls ?? [];
  if (controls.length === 0) return freezeReference(reference);
  const parameters: Record<string, WorldStyleParameterValue> = {};
  for (const control of controls) {
    parameters[control.key] = reference.parameters?.[control.key] ?? control.defaultValue;
  }
  return freezeReference({ ...reference, parameters });
}

function freezeStyleVersion(value: WorldStyleVersion): WorldStyleVersion {
  return Object.freeze({
    ...value,
    global: freezeReference(value.global),
    regions: Object.freeze(value.regions.map((region) => Object.freeze({ ...region }))),
  });
}

/** Unknown or removed profiles degrade to the catalog default without changing topology. */
export function resolveWorldStyleVersion(
  value: WorldStyleVersion,
  catalog: WorldStyleCatalog,
): WorldStyleResolution {
  const profiles = catalogProfiles(catalog);
  const warnings: string[] = [];
  const globalDescriptor = profiles.get(profileKey(value.global));
  const global = globalDescriptor !== undefined
    ? resolveReference(value.global, globalDescriptor)
    : (() => {
        warnings.push(`Unknown global style ${profileKey(value.global)}; using ${profileKey(catalog.defaultProfile)}.`);
        return catalog.defaultProfile;
      })();
  const regions: WorldRegionStyleOverride[] = [];
  for (const region of value.regions) {
    const descriptor = profiles.get(profileKey(region));
    if (descriptor === undefined) {
      warnings.push(`Unknown regional style ${profileKey(region)} on ${region.islandId}; override ignored.`);
      continue;
    }
    const resolved = resolveReference(region, descriptor);
    regions.push(Object.freeze({ islandId: region.islandId, ...resolved }));
  }
  regions.sort((a, b) => a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0);
  return Object.freeze({
    version: freezeStyleVersion({ ...value, global, regions }),
    warnings: Object.freeze(warnings),
  });
}

export interface WorldCustomizationControllerOptions {
  readonly topologyDigest: string;
  readonly regionIds: ReadonlySet<IslandId>;
  readonly catalog: WorldStyleCatalog;
  readonly initial?: WorldStyleVersion;
}

/**
 * The world-system boundary shared by Settings and Companion.
 *
 * Preview sessions are isolated. Applying creates an immutable version, discarding mutates no
 * world state, and rollback creates a new version rather than rewriting history.
 */
export class WorldCustomizationController {
  readonly topologyDigest: string;
  readonly #regionIds: ReadonlySet<IslandId>;
  readonly #catalog: WorldStyleCatalog;
  readonly #profiles: ReadonlyMap<string, WorldStyleDescriptor>;
  readonly #versions = new Map<string, WorldStyleVersion>();
  readonly #previews = new Map<string, WorldPreviewSession>();
  #current: WorldStyleVersion;

  constructor(options: WorldCustomizationControllerOptions) {
    if (options.topologyDigest.length === 0) throw new TypeError('topology digest must not be empty');
    this.topologyDigest = options.topologyDigest;
    this.#regionIds = new Set(options.regionIds);
    this.#catalog = Object.freeze({
      defaultProfile: freezeReference(options.catalog.defaultProfile),
      profiles: Object.freeze(options.catalog.profiles.map((profile) => Object.freeze({ ...profile }))),
    });
    this.#profiles = catalogProfiles(this.#catalog);
    const initial = options.initial ?? {
      versionId: 'world-style:0',
      revision: 0,
      parentVersionId: null,
      global: this.#catalog.defaultProfile,
      regions: [],
      appliedFromProposalId: null,
    };
    if (!Number.isSafeInteger(initial.revision) || initial.revision < 0) {
      throw new TypeError('world style revision must be a non-negative safe integer');
    }
    const resolved = resolveWorldStyleVersion(initial, this.#catalog).version;
    this.#current = resolved;
    this.#versions.set(resolved.versionId, resolved);
  }

  current(): WorldStyleVersion {
    return this.#current;
  }

  versions(): readonly WorldStyleVersion[] {
    return Object.freeze([...this.#versions.values()].sort((a, b) => a.revision - b.revision));
  }

  preview(proposal: WorldCustomizationProposal): WorldPreviewSession {
    const issues: WorldProposalIssue[] = [];
    if (proposal.baseStyleVersionId !== this.#current.versionId) {
      issues.push(Object.freeze({
        code: 'stale-style-version',
        detail: `Proposal targets ${proposal.baseStyleVersionId}; current style is ${this.#current.versionId}.`,
        protectedValue: false,
      }));
    }
    if (proposal.baseTopologyDigest !== this.topologyDigest) {
      issues.push(Object.freeze({
        code: 'topology-changed',
        detail: 'The protected world topology changed after this proposal was created.',
        protectedValue: true,
      }));
    }
    if (proposal.scope.kind === 'region' && !this.#regionIds.has(proposal.scope.islandId)) {
      issues.push(Object.freeze({
        code: 'unknown-region',
        detail: `Unknown region scope: ${proposal.scope.islandId}.`,
        protectedValue: false,
      }));
    }
    if (proposal.kind === 'structural') {
      issues.push(Object.freeze({
        code: 'structural-preview-unavailable',
        detail: 'Structural changes require a topology recomposition and navigation validation; this foundation does not apply them.',
        protectedValue: true,
      }));
    } else if (!this.#profiles.has(profileKey(proposal.profile))) {
      issues.push(Object.freeze({
        code: 'unknown-style-profile',
        detail: `Unknown world style: ${profileKey(proposal.profile)}.`,
        protectedValue: false,
      }));
    } else {
      issues.push(...parameterIssue(this.#profiles.get(profileKey(proposal.profile))!, proposal.profile));
    }

    const validation = Object.freeze({ ok: issues.length === 0, issues: Object.freeze(issues) });
    let candidate: WorldStyleVersion | null = null;
    if (validation.ok && proposal.kind === 'appearance') {
      let global = this.#current.global;
      const regionMap = new Map(this.#current.regions.map((value) => [value.islandId, value] as const));
      const descriptor = this.#profiles.get(profileKey(proposal.profile))!;
      const resolvedProfile = resolveReference(proposal.profile, descriptor);
      if (proposal.scope.kind === 'global') global = resolvedProfile;
      else regionMap.set(proposal.scope.islandId, Object.freeze({
        islandId: proposal.scope.islandId,
        ...resolvedProfile,
      }));
      const regions = [...regionMap.values()].sort(
        (a, b) => a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0,
      );
      candidate = freezeStyleVersion({
        versionId: `world-style-preview:${proposal.proposalId}`,
        revision: this.#current.revision,
        parentVersionId: this.#current.versionId,
        global,
        regions,
        appliedFromProposalId: proposal.proposalId,
      });
    }
    const session = Object.freeze({
      sessionId: `world-preview:${proposal.proposalId}:${this.#current.revision}`,
      proposal: Object.freeze({ ...proposal }),
      validation,
      candidate,
      topologyDigest: this.topologyDigest,
    });
    this.#previews.set(session.sessionId, session);
    return session;
  }

  discard(sessionId: string): void {
    this.#previews.delete(sessionId);
  }

  apply(sessionId: string): WorldStyleVersion {
    const session = this.#previews.get(sessionId);
    if (session === undefined) throw new TypeError(`unknown world preview session: ${sessionId}`);
    if (!session.validation.ok || session.candidate === null) {
      throw new TypeError(`world preview session is not applicable: ${sessionId}`);
    }
    if (session.proposal.baseStyleVersionId !== this.#current.versionId) {
      throw new TypeError(`world preview session became stale: ${sessionId}`);
    }
    const revision = this.#current.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError('world style revisions are exhausted');
    const applied = freezeStyleVersion({
      ...session.candidate,
      versionId: `world-style:${revision}:${session.proposal.proposalId}`,
      revision,
      parentVersionId: this.#current.versionId,
    });
    this.#current = applied;
    this.#versions.set(applied.versionId, applied);
    this.#previews.delete(sessionId);
    return applied;
  }

  rollback(targetVersionId: string): WorldStyleVersion {
    const target = this.#versions.get(targetVersionId);
    if (target === undefined) throw new TypeError(`unknown world style version: ${targetVersionId}`);
    const revision = this.#current.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError('world style revisions are exhausted');
    const rollback = freezeStyleVersion({
      versionId: `world-style:${revision}:rollback-${encodeURIComponent(targetVersionId)}`,
      revision,
      parentVersionId: this.#current.versionId,
      global: target.global,
      regions: target.regions,
      appliedFromProposalId: null,
    });
    this.#current = rollback;
    this.#versions.set(rollback.versionId, rollback);
    return rollback;
  }
}
