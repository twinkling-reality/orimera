# Atlas frontend integration

Status: **IMPLEMENTED** for the global world-appearance lifecycle and production source-media
loading.

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

## Deliberate remaining boundary

The backend may hold regional overrides, but the current renderer exposes only a reviewed global
profile preview. Atlas parses regional history without reinterpreting it and refuses an upstream
regional proposal rather than painting it globally. Regional controls require a reviewed
per-region renderer implementation. Structural proposals remain outside the appearance API.

## Verification

Focused browser-unit coverage lives in:

- `web/packages/app/test/world-style-api.test.ts`;
- `web/packages/app/test/source-media-api.test.ts`;
- `web/packages/app/test/world-style-proposals.test.ts`;
- `web/packages/app/test/options.test.ts`; and
- `web/packages/app/test/surface.test.ts`.

The backend wire and database guarantees remain covered by `tests/test_world_api.py`,
`tests/test_world_style_contract.py`, and `tests/test_world_style_postgres.py`.
