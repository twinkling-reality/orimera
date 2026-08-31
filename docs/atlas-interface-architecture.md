# Atlas interface architecture

Status: **IMPLEMENTATION PLAN**. This plan is grounded in the frontend at `6685041`, the live
development preview, and the active graph, evidence, Selection, world-style, and Companion
appearance contracts. It introduces no new graph fields or backend behavior.

## Observed baseline

The audit used the Aeroheart preview at 1440×900 and 1366×768, including keyboard entry, Index
detail, Map, Options, Controls, and the summoned Companion.

| Surface | Observed problem | Existing contract that decides the change |
| --- | --- | --- |
| Index | The visible surface is a narrow list. Its implemented Kind, Status, Presence, and Source facets are not exposed, provenance is reduced to unexplained `U/C/I` initials, and rows omit occurrence and region context. | `interaction-model.md` 6.1 and `world-index/facets.ts` already define the four facets, linkable encoding, row data, and fixed detail order. |
| Index detail | At short laptop height the detail is a second long scroll, the quick commands overlap its header, and list/detail read as unrelated cards rather than one evidence workspace. | Index must remain a keyboard-first overlay above the live Atlas; every citation must retain source and Locate access. |
| Map | The renderer correctly saves and restores the ground pose, but opening Map from a selected Index detail clears the Index context. The permanent caption is visually weak. | `atlas-core` already owns exact camera restoration. The application shell must separately restore the prior primary surface, selection, and detail. |
| Options | Display, world design, navigation comfort, Companion identity, and controls are one dense scrolling sheet. At 1366×768 the live world is not a useful persistent preview and Companion changes have no dedicated preview. | World appearance is a validated appearance transaction; Companion appearance is a separate V3 version family; access preferences override both. |
| Controls | The guide is readable and protected, but it is coupled to Options as a peer toggle without a larger Atlas hierarchy. | Controls and accessibility remain system-owned, with world adaptation limited to derived readable roles and materials. |
| Companion | The visual-novel encounter is coherent and must stay intact, but it has no app-owned route into Companion appearance or World design. | The Companion may deep-link to a section but may not become its only route or gain a separate proposal engine. |

## Ownership boundary

Orimera owns the shell reducer, section hierarchy, component markup, circular command geometry,
keyboard shortcuts, focus order, source actions, semantic labels, protected-value copy, transaction
verbs, and context restoration. World profiles may supply only the validated, versioned visual
roles already accepted by `@orimera/presentation`: derived palette roles, registered type families,
bounded blur/saturation/texture, and bounded motion timing. Reduced motion, reduced transparency,
high contrast, focus visibility, and minimum contrast override that expression.

The UI never reads a style parameter as CSS, selector, markup, shader, coordinate, radius, hit area,
semantic color, or behavior. World controls continue to render from the active capability manifest.
Companion controls continue to resolve through the V3 appearance configuration and never enter the
world-style or graph version families.

## Aeroheart direction

The subject is a personal evidence world. The interface's job is to let someone move between the
world, its evidence, and bounded appearance work without losing their place.

- Palette: Open air `#5ea8b2`, horizon volume `#e8d8c7`, continuity depth `#153f4b`, relationship
  gold `#ffd27a`, source ivory `#f8f3dc`, unresolved violet `#7c71b5`. Runtime components consume
  their contrast-corrected semantic derivatives rather than these literals.
- Type: the profile's validated display family for titles, body family for reading, utility family
  for shortcuts, state, and evidence metadata. No component-owned fallback is added.
- Materials: Index and evidence use the archive material; Atlas workshop pages use the instrument
  material; Controls and accessibility use the more opaque protected system material.
- Signature: a **source register** runs through the Index workspace. It aligns filters, result
  selection, provenance, and the open detail as one evidence instrument. It is structural, not a
  decorative timeline: its marks identify the active facet/result and the provenance class in use.

The planned layouts are:

```text
INDEX
┌ facets ─────┬ results and provenance ───────────┬ selected evidence ─────────┐
│ four groups │ search / result count / rows       │ identity / four bands      │
│ clear state │ occurrence + region + confidence   │ sources / relations / log  │
└─────────────┴────────────────────────────────────┴─────────────────────────────┘
                       live Atlas remains visible around and beneath the sheet

ATLAS INSTRUMENT
┌ sections ───┬ active workshop ────────────────────────────┬ live register ─┐
│ World       │ generated capability controls              │ preview state  │
│ Companion   │ appearance controls + real avatar preview  │ protected list │
│ Display     │ protected access overrides                 │ Apply / Undo   │
│ Movement    │ view and comfort                           │ when relevant  │
│ Controls    │ keyboard guide                             │                │
└─────────────┴─────────────────────────────────────────────┴────────────────┘
```

This avoids the generic dashboard pattern in the baseline: sections are not simultaneous tiles,
and the one persistent right register explains state and ownership. The one aesthetic risk is the
archive-like source register; it is justified because provenance is the product's core distinction.
Everything else stays quiet so exact media remains visually dominant.

## Implementation plan

1. Replace shell toggles with a restorable surface context so Map and system surfaces return to the
   prior Index/detail state without touching the renderer-owned camera stack.
2. Render the existing four Index facets, URL-compatible query state, complete row metadata,
   readable provenance legend, search, result count, and the unchanged fixed detail/source order in
   one responsive desktop evidence workspace.
3. Reshape Options into one Atlas instrument with direct World, Companion, Display, Movement, and
   Controls routes. Keep world preview/apply/discard separate from immediately applied protected
   preferences, and give the action register explicit saved/preview/protected language.
4. Reuse the real Companion SVG appearance renderer in a persistent workshop preview. Add an
   app-owned Companion utility deep-link into Companion appearance; it performs no graph or model
   action.
5. Art-direct Aeroheart archive, instrument, map caption, compact command strip, and Companion
   preview using only the current world-derived tokens. Keep Controls and access pages more opaque.
6. Verify reducer invariants, DOM contracts, keyboard/focus behavior, preview/apply/discard,
   viewport behavior, reduced motion, reduced transparency, high contrast, and the production-shaped
   journey in the rendered preview and full frontend suite.

## Intentionally bounded scope

The current graph read model does not expose user-facing region names to Index facets, calibrated
confidence percentages, persisted Selection routes, production world-style persistence, structural
customization, conversational style authoring, or backend undo history for appearance. The frontend
will not invent them. Presence filters use honest region ordinals plus their existing date/count
metadata; confidence remains qualitative; appearance remains the documented per-device adapter.
