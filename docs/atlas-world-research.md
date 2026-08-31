# Atlas world composition research

Status: **VERIFIED** for repository measurements and cited source behavior; **DECISION** for the
recommended architecture; **ASSUMPTION** where an experience claim still needs user study.
Research and repository audit performed 2026-08-29; visual reset verified 2026-08-30. This document does not claim that backend
persistence, reconstructed navigation assets, or physical streaming are complete.

## 1. Question and product-specific constraint

The question was not “how do games generate large worlds?” It was: how can Atlas become a durable,
modular personal-memory world without allowing presentation, reconstruction, or procedural variety
to become a source of historical fact?

That changes the usual optimization target. Atlas must preserve five values before it optimizes
variety:

1. evidence fidelity — a visual body never creates support that the source archive does not have;
2. spatial memory — stable identities and placements survive reloads and unrelated graph changes;
3. reachability — every required region remains safely reachable under its earned rung;
4. legibility — landmarks, routes, and the overview agree;
5. bounded cost — large libraries do not make composition, routing, residency, or rendering
   quadratic.

Microsoft Research's MyLifeBits is relevant as an archive precedent, but it is not evidence for a
3D interaction model. Its durable lesson is that a lifetime store needs capture, organization,
retrieval, and provenance rather than one privileged folder hierarchy.

- Microsoft Research, MyLifeBits: https://www.microsoft.com/en-us/research/project/mylifebits/
- Supporting Human Memory with a Personal Digital Lifetime Store:
  https://www.microsoft.com/en-us/research/wp-content/uploads/2007/01/Supporting-Human-Memory-with-a-Personal-Digital-Lifetime-Store.pdf

## 2. What mature procedural systems actually contribute

The useful common pattern is **global assembly from bounded, authored pieces**, followed by
validation and runtime refinement. It is not “give every object intelligence.”

- Far Cry 5's generation presentation describes deterministic generation and navigation work as
  pipeline concerns. The Atlas analogue is a versioned compiler artifact, not renderer-local
  randomness: https://media.gdcvault.com/gdc2018/presentations/ProceduralWorldGeneration.pdf
- Horizon Zero Dawn's placement system uses rule-driven procedural placement around the player.
  The transferable idea is rule graphs with inspected outputs; the non-transferable idea is that
  environment placement can be freely regenerated, because Atlas positions must persist:
  https://www.guerrilla-games.com/read/gpu-based-procedural-placement-in-horizon-zero-dawn
- Returnal connects handcrafted rooms procedurally. That supports modules with explicit sockets and
  a global layout pass; it does not support autonomous modules or truth-changing randomization:
  https://media.gdcvault.com/GDC%2B2022/Speaker%2BSlides/Never%2BThe%2BSame_Watson_Ethan.pdf
- No Man's Sky shows a continuous runtime generation pipeline. Atlas should borrow deterministic
  generation, streaming boundaries, and hierarchical representation, not planetary scale or
  content invention: https://www.gdcvault.com/play/1024265/Continuous_World_Generation_in__No_Man_s_Sky_
- Unreal's PCG/World Partition integration makes generated actors inherit data and HLOD layers.
  This supports making residency metadata an output of composition rather than reconstructing it
  in the renderer:
  https://dev.epicgames.com/documentation/unreal-engine/using-pcg-with-world-partition-in-unreal-engine

**DECISION:** modules are passive, immutable catalog entries. Recipes declare valid attachment
graphs. A deterministic composer sees the complete input, resolves fallbacks, emits provenance,
builds a navigation graph, and validates the whole result.

## 3. Identity, provenance, and persistence

W3C PROV separates entities, activities, and responsible agents, and provides generation and
derivation relationships. Atlas uses the same conceptual split: a world element is an entity; a
specific composer/recipe version is its generating activity; source region, confirmed relation,
reconstruction rung, and presentation rule are retained causes.

- W3C PROV-O: https://www.w3.org/TR/prov-o/
- W3C PROV overview: https://www.w3.org/TR/prov-overview/

Stable element identity is derived from stable semantic ownership plus recipe and slot keys, never
from a mutable transform, catalog version, or graph state counter. RFC 9562 documents name-based
UUIDs but also warns against mutable natural keys. The current foundation uses readable stable
keys; production may encode the same tuple into a UUID namespace after the tuple is frozen.

- RFC 9562: https://www.rfc-editor.org/rfc/rfc9562.html

The draft topology digest is deterministic over quantized, ordered topology. It is intentionally
not represented as a cryptographic persistence checksum. Production storage should canonicalize
the JSON payload using JCS and hash the canonical bytes. JCS exists precisely to make JSON
repeatably hashable.

- RFC 8785, JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785.html

**DECISION:** the frontend composer emits `persistenceStatus: "draft"`. Backend authority must
compare the proposal's base world/layout versions, validate again, write the snapshot and current
pointer atomically, and return the persisted ID. PostgreSQL Serializable transactions provide the
appropriate “as if one at a time” guarantee, with whole-transaction retry on serialization failure.

- PostgreSQL transaction isolation:
  https://www.postgresql.org/docs/current/transaction-iso.html#XACT-SERIALIZABLE

The original research implementation changed no backend file. Phase 4 now implements the backend
authority described above: the frontend value remains a draft, while canonical SHA-256 production,
live dependency validation, immutable persistence, and compare-and-swap belong to
`WorldStructureRepository`.

## 4. Navigation and wayfinding

Landmark research consistently treats visibility and salience as important, particularly along
routes and at decision points. A controlled virtual-environment study also found that persistent
global landmark silhouettes improved later map drawing. These findings support sparse, distinctive
orientation registers. They do not prove that Atlas's specific forms work; that remains a study.

- Review of landmarks in wayfinding: https://pubmed.ncbi.nlm.nih.gov/33682034/
- Virtual global landmark study: https://pubmed.ncbi.nlm.nih.gov/35469001/
- Landmark, route, and survey knowledge study: https://pubmed.ncbi.nlm.nih.gov/32666265/

**ASSUMPTION:** Aeroheart's memory lenses, living beacons, water-glass approaches, and vector signals
will improve return-to-place accuracy over labels alone. Settle this with a repeated-session study measuring
destination time, wrong turns, map reconstruction, and placement recall at 3, 30, and 100 regions.

Navigation must consume authored proxies, not splats. Recast is useful as a reference contract:
agent radius, walkable climb, tiled meshes, path queries, and tile streaming are explicit, and
walkability is derived from navigation input rather than render samples.

- Recast Navigation: https://github.com/recastnavigation/recastnavigation
- Recast configuration notes:
  https://github.com/recastnavigation/recastnavigation/blob/main/Docs/Extern/Recast_api.txt

The implemented foundation now samples the full movement and direct-travel segment at bounded
intervals, rejects missing surfaces, excessive normal slope, and discontinuous steps, and uses the
same coarse blockers for locomotion, visibility, and travel. Rung-2 trajectories and rung-3 panel
envelopes remain missing measured inputs; no synthetic trajectory was added.

## 5. Appearance profiles versus structural variants

Material variants are safe only when they reuse compatible geometry. Khronos explicitly frames
`KHR_materials_variants` as multiple materials over one geometry and distinguishes it from shape
or size variation. Atlas therefore treats exposure, material family, and topology-compatible
silhouette realization as appearance. A variant becomes structural if it changes bounds, sockets,
collision, navigation, evidence bindings, or reconstruction capability.

- Khronos material variants:
  https://www.khronos.org/blog/streamlining-3d-commerce-with-material-variant-support-in-gltf-assets
- glTF registry and validator ecosystem: https://registry.khronos.org/glTF/
- Design Tokens Format Module 2025.10:
  https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/

Two profiles remain implemented over one topology compatibility key, but they no longer have equal
product status:

- **Aeroheart** — the sole complete user-facing default: bright living terrain, optical memory
  lenses, water-glass approaches, growth forms, and precise vector signals. Its risk is becoming a
  generic eco-future unless personal source media and region-specific expression provide identity.
- **Survey Relief** — retained only as a topology-compatible renderer regression fixture. It is not
  offered as a second identity in Options.

The prior Celestial Emulsion / Blue Hour opening was rejected after live viewport review: the
vertical luminous scaffolding, ambient labels, and blue-purple wash read as a renderer test rather
than a personal place. That visual finding overrides the earlier untested profile proposal without
changing the topology or evidence contracts.

The profiles use shape/stroke or outline alongside hue. WCAG requires non-text graphical objects
needed for understanding to retain adequate contrast, and animation from interactions should be
disableable when non-essential.

- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Animation from interactions:
  https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions

## 6. Streaming and rendering at library scale

The runtime hierarchy is full-library index → neighborhood → region → module LOD. The topology
artifact stays resident; detailed assets do not. OGC 3D Tiles provides a useful external model for
hierarchical LOD, screen-space error, bounding volumes, and streaming. PlayCanvas provides actual
load/unload APIs and draw-call reduction mechanisms.

- OGC 3D Tiles 1.1: https://docs.ogc.org/cs/22-025r4/22-025r4.html
- PlayCanvas loading and unloading:
  https://developer.playcanvas.com/user-manual/assets/loading-unloading/
- PlayCanvas batching:
  https://developer.playcanvas.com/user-manual/graphics/advanced-rendering/batching/
- PlayCanvas multi-draw:
  https://developer.playcanvas.com/user-manual/graphics/advanced-rendering/multi-draw/

**Repository measurement:** the former neighborhood builder generated every pair of neighborhoods
sharing an entity. A 10,000-region all-shared fixture took about 17.6 seconds and emitted 86,736
routes. The bounded implementation treats very high-fanout entities as non-discriminating for
grouping/routing, caps semantic degree, and retains an index backbone. The same 10,000-region test
now completes in roughly 25–35 ms on the audit machine and emits one sparse chain. A deliberately
wide 2.5-second CI ceiling guards the superseded failure mode without pretending to be a device
benchmark.

## 7. Repository audit: present contradictions and remaining work

| Priority | Finding | Current disposition |
| --- | --- | --- |
| P0 | Layout and neighborhood artifacts have frontend validators but no backend persistence authority. | Draft status and CAS boundary documented; backend unchanged. |
| P0 | Direct travel and movement sampled only endpoints. | Bounded path, slope, step, and blocker checks implemented. |
| P0 | Rung policies existed as a helper but measured rung-2/3 artifacts were absent. | No fake paths added; pipeline ingestion remains required. |
| P0 | Dense shared entities caused quadratic neighborhood grouping/routes. | Near-linear grouping, ubiquitous-entity cutoff, degree cap, and stress test implemented. |
| P1 | Residency acknowledges already-constructed assets; it is planning, not physical streaming. | Contract retained and named honestly; loader work remains. |
| P1 | World-field shader has fixed 5-region/10-trace uniform limits. | Kept for current preview; module/path realization removes some dependence, but scalable buffers remain. |
| P1 | Current source cards are honest but blank and can dominate the first-person frame. | Kept honest; real source media and art-directed evidence bodies remain pipeline/UI work. |
| P1 | The first replacements read as blue scaffolding, then as an olive low-poly rock garden. | Aeroheart replaces those primitives with legible lenses, beacons, growth, water-glass, and signal paths; live art-direction validation remains required. |
| P2 | Per-frame mote buffer updates and unbounded object-level realization need GPU batching. | Explicit next performance phase; current module visuals share meshes/materials but are separate instances. |

## 8. Phased roadmap and acceptance gates

1. **Persist authority.** Add backend world topology/style tables, immutable versions, current
   pointer, JCS/SHA-256 digest, serializable compare-and-swap, migrations, deletion invalidation,
   export, and rollback. Gate: two stale writers cannot both become current.
2. **Ingest measured traversal.** Add rung-1 nav surfaces, rung-2 camera trajectories, rung-3 panel
   envelopes, clearance validation, and artifact hashes. Gate: every published destination is
   reachable with one agent radius and the renderer cannot widen the path.
3. **Stream physically.** Make residency actions load, cancel, unload, and dispose real resources;
   add neighborhood origin rebasing. Gate: a large corpus holds topology constant while GPU/CPU
   memory stays within declared budgets.
4. **Batch realization.** Move repeated modules and relationship traces to instancing/multi-draw;
   replace fixed shader arrays with texture/storage buffers. Gate: measured 1% low and draw-call
   budgets on target desktop/laptop profiles.
5. **Complete customization policy.** Capability-backed per-style manifests now generate Settings
   controls and use the protected preview/apply/discard lifecycle. Reference provenance, new-style
   registration, production persistence, and structural previews remain. Gate: discard is bitwise
   topology-neutral, unknown capabilities fail, and stale apply fails.
6. **Validate experience.** Run wayfinding, return-session recall, reduced-motion, keyboard, zoom,
   contrast, Aeroheart plus the internal Survey regression fixture, and 3/30/100-region
   tests. Gate: predeclared thresholds,
   not screenshots alone.
