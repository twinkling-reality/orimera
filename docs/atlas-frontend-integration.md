# Atlas frontend integration

Status: **IMPLEMENTED** for the global world-appearance lifecycle, production source-media
loading, and production reconstruction geometry.

## Authority split

The backend owns immutable versions, the current pointer, style and topology compare-and-swap
tokens, proposal status, actor/origin, acceptance and rejection, refinement lineage, rollback,
references, model/prompt versions, authorization, and source-slot provenance.

The frontend owns the reviewed recipe and module implementations, strict capability/parameter
validation, contrast correction, protected component geometry, accessibility, and preview
rendering. Recipe payloads remain inert. No API response can introduce CSS, HTML, JavaScript,
shaders, renderer programs, layout instructions, or a remote texture URL.

`web/packages/app/src/world-style-api.ts` is the one translation layer between the backend's
snake-case persisted records and the frontend's camel-case registry contract. Startup rejects an
unknown catalog version, frontend contract commit, profile version, module list, control manifest,
or capability mapping before applying it. Valid current state hydrates the renderer and Options;
local storage is only a device cache.

## Review lifecycle

Direct Options controls render immediately through the local trusted modules and create an isolated
backend preview after a short input debounce. Undo, leaving Options, or replacing a preview closes
the backend preview without moving the current pointer. Apply posts the exact preview bases and
updates the UI only after the server returns a new immutable version.

If preview creation is stale, the client reads current state and creates a new proposal linked to
the rejected proposal through `refinesProposalId`. If Apply becomes stale, that recovered preview
is shown but is not silently applied; the person reviews and applies again. Rollback similarly
refreshes on a conflict and requires the target to be chosen again. Successful rollback creates a
new revision and leaves the target untouched.

Options shows current revision and ID, actor/origin/origin reference, model and prompt provenance,
warnings, proposal refinement/reference information, and immutable history. Loading, unavailable,
failed, checking, saved, and stale states are announced through live regions and remain keyboard
operable inside the existing modal focus boundary.

## Conversational proposals

`web/packages/app/src/world-style-proposals.ts` is an in-process typed inbox for a future upstream
proposal service. It does not call a model or convert prose. A service supplies an already
structured profile proposal. Companion input must include an origin reference, at least one opaque
reference ID, a model ID, and a prompt version. The normal local and backend validation paths then
produce the same preview UI used by Settings. A refinement is another upstream proposal carrying
the prior proposal ID.

No production conversational proposal service exists in this repository. That is an external
integration dependency, not a mocked browser feature.

## Source media

`web/packages/app/src/source-media-api.ts` reads protected source slots, verifies the
workspace-bearer authorization declaration, local `/evidence/` path, source ID, and evidence-span
provenance, then fetches bytes with the bearer header. Only an image response becomes a blob URL.
Blob URLs are revoked at session disposal. Available, unavailable asset, missing evidence,
unauthorized, provenance-error, and network-error states remain distinct and visible; no fallback
image is invented.

## Reconstructed geometry

**ADR-0009 D10, and it was the first item of work in that record for a reason.** Until this
shipped there was no production path by which any point map reached the renderer: no route served
artifact bytes, and the only loader in the workspace was the development preview. A posed set, a
corridor and the designed void would all have been built against nothing.

The backend serves two routes and they are a pair. `GET /geometry` is a descriptor list keyed by
capture, saying which container each reconstruction is in, how many bytes it is, and the SHA-256
those bytes must hash to. `GET /geometry/{artifact_id}` is the bytes. Neither ships an island id,
because ADR-0005 leaves what an island is to the client; neither ships a rung, because the
recorded rung claim already arrives on the graph payload at the granularity a region is drawn at,
and a second copy on the wire is the divergence ADR-0009 D11 objects to.

`web/packages/app/src/geometry-api.ts` reads the list, checks each reference declares
`workspace-bearer` and a local `/geometry/` path, fetches the bytes with the bearer header,
computes SHA-256 over what arrived, and compares it **to the descriptor** rather than to the
response's own `ETag`. Bytes that fail never reach the decoder. A page with no `SubtleCrypto`
loads no geometry at all and says so, rather than decoding what it could not check.

A region attempts one reconstruction. `AtlasBinding` takes one point map per island and, until
the placement record of ADR-0009 D6 exists, nothing records where a second camera stood; the first
descriptor the server returned for a region is the one attempted and every other one becomes an
`unplaced` notice. Attempted rather than drawn: a region whose candidate fails does not fall
through to the next, so a load costs at most one point map per region whatever goes wrong. Every
request carries its own deadline, because `fetch` has none and `mount()` waits for this. Missing
bytes, an unreadable container, a failed digest, an unverifiable page, a timeout, a deletion, an
unauthorised session, a decode failure and a state this build does not recognise stay distinct;
they are shown on the status bar one line per kind with a count, because `unplaced` is the
ordinary state of a photograph in a multi-photograph region and one line each would become the
page. No region invents geometry it does not have: a region without one is rung 4 rendered as
rung 4, and every citation in it still resolves.

The load runs on **every** mount, not once at start-up. The descriptor list is re-read and the
bytes are not: a map already decoded is carried forward by artifact id. That is what carries a
deletion to the renderer, because a region whose descriptor has gone loses its geometry on the
next mount rather than keeping it for the life of the tab. The bytes are served `no-store`, so a
deleted region's reconstruction is not redrawable from the browser's own disk cache afterwards.

## Deliberate remaining boundary

The backend may hold regional overrides, but the current renderer exposes only a reviewed global
profile preview. Atlas parses regional history without reinterpreting it and refuses an upstream
regional proposal rather than painting it globally. Regional controls require a reviewed
per-region renderer implementation. Structural proposals remain outside the appearance API.

## Verification

Focused browser-unit coverage lives in:

- `web/packages/app/test/world-style-api.test.ts`;
- `web/packages/app/test/source-media-api.test.ts`;
- `web/packages/app/test/geometry-api.test.ts`;
- `web/packages/app/test/world-style-proposals.test.ts`;
- `web/packages/app/test/options.test.ts`; and
- `web/packages/app/test/surface.test.ts`.

The backend wire and database guarantees remain covered by `tests/test_world_api.py`,
`tests/test_world_style_contract.py`, and `tests/test_world_style_postgres.py`. The geometry
routes are covered by `tests/test_geometry_delivery.py`, and their authorisation by the
router-generated sweep in `tests/test_api.py`.
