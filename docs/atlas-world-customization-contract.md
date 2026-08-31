# Atlas world customization contract

Status: **DECISION** and **IMPLEMENTED BACKEND FOUNDATION**. Appearance transactions, generated
parameter controls, PostgreSQL authority, and the HTTP lifecycle exist. A complete multi-style
editor and structural topology editor do not.

## 1. Protected topology

A proposal may not silently change any of these values:

- world/region/relationship ownership;
- module and recipe identity/version;
- transforms, attachments, sockets, or stable instance IDs;
- collision or navigation contracts;
- required destinations and reachability;
- evidence requirement, evidence binding, reconstruction rung, or provenance;
- streaming identity and minimum accessible labeling contract.

The topology digest is the optimistic concurrency token for those values. The backend persists and
compares the composer-supplied digest but does not claim a non-cryptographic frontend draft is
cryptographic; canonical digest production remains the topology composer's responsibility.

## 2. Appearance proposal

An appearance proposal contains:

```text
proposalId
origin: user | settings | companion
kind: appearance
scope: global | region(islandId)
baseStyleVersionId
baseTopologyDigest
profile: profileId + profileVersion + validated parameter values
referenceIds
modelId + promptVersion (Companion only)
refinesProposalId (optional)
```

Preview creates an isolated candidate style version. It does not change current state. Apply is
valid only if the preview succeeded and its base style version is still current. Discard deletes
the preview only. Rollback appends a new immutable version whose values match a prior version;
history is never rewritten.

## 3. Structural proposal

Moving a region, changing neighborhood membership, or replacing a module with an incompatible
contract is structural. The current controller rejects it with
`structural-preview-unavailable` and marks the issue as protecting a value.

A future structural controller must:

1. compose a candidate topology against an explicit base snapshot;
2. show a protected-value diff including moved identities, reachability, collision, reconstruction,
   evidence, and residency impact;
3. run attachment, bounds, clearance, slope, destination, and accessibility validation;
4. persist only through backend compare-and-swap;
5. leave the current snapshot intact on conflict or failed validation.

## 4. Profile compatibility and programmable controls

Aeroheart (stored under the legacy-stable `origin-landscape` profile ID) and the internal Survey
Relief regression fixture use `atlas-topology-v1`. They may vary silhouette realization,
materials, accents, detail density, and atmospheric response inside authored module bounds. They
may not change sockets, collision, navigation, evidence, or destination positions.

A style descriptor owns a parameter manifest. Each control has a stable key, a renderer capability,
kind, group, label, explanation, safe range/options, and default. Different styles may expose
different manifests. Options renders the active manifest rather than hard-coding Aeroheart sliders.

The frontend recipe contract inspected at `55b1236` is the execution boundary. Its version-one
recipe contains `schemaVersion`, product/developer availability, authored/generated origin, a
versioned visual profile, bounded controls, and reviewed local module IDs. The frontend owns the
visual profile, module implementations, exact capability validation, contrast correction,
protected component geometry, preview rendering, reduced-motion behavior, and accessibility. The
backend does not reproduce that visual source. It returns and persists an inert `recipeBinding`
containing only the exact schema/profile version, module IDs, and control-to-capability mapping.
That is an adapter to the existing client recipe, not a second style language.

Backend proposals can select a registered recipe version and parameter values. They cannot carry
CSS, markup, JavaScript, shaders, renderer programs, remote texture URLs, private media, interface
layout, or new module implementations. A Companion proposal also carries durable reference IDs,
model ID, prompt version, actor/origin, and optional refinement lineage; conversation text and
preview-session state are excluded. Apply records those values on the immutable version. Rejection,
discard, stale closure, refinement, and rollback remain inspectable without turning transient
conversation into a durable preference.

The trusted renderer capability registry is the limit of runtime AI programmability. A model may
select capabilities, rename controls, narrow ranges, choose defaults, and propose values. It may not
invent an executable binding, widen a protected range, or ship generated shader/code into the
runtime. A genuinely new renderer feature remains a reviewed software change. Unknown bindings,
unknown parameters, invalid values, and out-of-range values fail before preview.

Aeroheart is the sole complete user-facing identity and uses the authored daylight exposure. The
minimum presentation matrix is therefore:

- Aeroheart × Standard and High contrast;
- Aeroheart × Layered and Reduced transparency;
- Survey Relief × the renderer regression suite only.

Color is never the only semantic carrier. Provenance uses hue + shape, confirmation uses hue +
stroke, and focus uses contrast + outline.

## 5. Failure and fallback rules

- unknown recipe/profile version, module, capability, or parameter in a new proposal or client
  handshake → fail closed before preview;
- unknown or removed profile in immutable historical data → display a warned default/ignored
  regional override, discarding the old parameters rather than reinterpreting them;
- stale style base → reject preview/apply;
- changed topology digest → reject as a protected conflict;
- unknown region → reject;
- missing reconstruction asset → composer resolves the module's honest source-evidence fallback;
- incompatible/invalid attachment → reject composition;
- unreachable required destination → reject composition;
- failed/discarded preview → current style and topology remain unchanged.

Settings and Companion are proposal origins, not separate rule engines. Settings now exposes the
active style's generated parameter controls. It does not expose the incomplete Survey fixture as a
product choice. Slider movement uses an isolated preview; release applies one immutable version.
The renderer binding exposes the same Companion-origin preview/apply/discard methods; the separately
owned Companion UI was not changed.

Design references belong to proposal provenance. The intended flow is:

`conversation + reference IDs → capability-backed manifest/values → validation → live preview → apply/refine/discard → immutable version`

The model may explain which reference traits mapped to which capability. Reference images and
conversation text are not renderer instructions and never bypass manifest validation.
The production boundary is `orimera/world/`, migrations `0017_adaptive_world_styles.sql` and
`0023_frontend_world_recipe_contract.sql`, and the `/world/styles` routes. Durable versions and
current pointers live there; live conversation and isolated preview sessions remain separate. See
[world-style-backend.md](world-style-backend.md).

The referenced frontend commits are not ancestors of this backend worktree; their merge base is
`c5f4c029f53013cb209af70e2814e7482cd332c5`. This branch therefore reproduces only the shared inert
contract pinned to `55b123627314d328fba3850eb607d8a7682a8cad`. Integrating the actual frontend
registry, versioned previews, Atlas journey, and verified visual system still depends on commits
`55b1236`, `6b6b282`, `8ccebb3`, and `5c95cb3` (or reviewed descendants). It does not cherry-pick
or redesign them.

## 6. Source-media contract

Source bindings are protected topology values, not style parameters. Each registered source slot
either names an evidence span from the same workspace or records why no evidence exists. Reads
distinguish `available`, `unavailable_asset`, and `missing_evidence`; cross-workspace and nonexistent
source IDs are indistinguishable. Available sources expose an authenticated local evidence path
plus a provenance-bearing asset reference naming the protected source slot and evidence span.
Unavailable states expose no asset reference. Private media remains in the evidence store and
never enters a style recipe.
