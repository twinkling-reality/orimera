# Atlas world customization contract

Status: **DECISION** and **ACTIVE IMPLEMENTATION**. Appearance transactions and generated
parameter controls exist; the production persistence adapter and complete multi-style editor do not.

## 1. Protected topology

A proposal may not silently change any of these values:

- world/region/relationship ownership;
- module and recipe identity/version;
- transforms, attachments, sockets, or stable instance IDs;
- collision or navigation contracts;
- required destinations and reachability;
- evidence requirement, evidence binding, reconstruction rung, or provenance;
- streaming identity and minimum accessible labeling contract.

The topology digest is the optimistic concurrency token for those values. Production must replace
the draft non-cryptographic digest with a canonical cryptographic digest at the persistence seam.

## 2. Appearance proposal

An appearance proposal contains:

```text
proposalId
origin: settings | companion
kind: appearance
scope: global | region(islandId)
baseStyleVersionId
baseTopologyDigest
profile: profileId + profileVersion + validated parameter values
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

- unknown or removed global profile → catalog default plus warning;
- unknown regional profile → ignore that override plus warning;
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
Production must persist the resulting immutable style version through the backend boundary rather
than relying on the present per-device preference.
