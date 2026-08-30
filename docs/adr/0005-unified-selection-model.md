# ADR-0005: One Selection primitive, many entry points

- Status: Accepted
- Date: 2026-08-28
- Supersedes nothing. Extends ADR-0003 and the recomposition design in `interaction-model.md`.
  Its mobile-delivery consequences are superseded by ADR-0006.

## Context

The interaction model as originally specified treats several things as separate mechanisms:

- Selecting a person in the Atlas highlights their occurrences.
- The World Index searches an inventory of people, places, objects, events, conversations, scenes.
- The Companion answers questions conversationally.
- The Atlas Map shows a pulled-back semantic view.

Two problems became visible once the corpus turned out to be a personal travel photograph library
rather than five curated captures.

**First, time and place were missing as filter dimensions.** The brief's recurrence thesis is
carried by "a recurring person, place, object, conversation, or event", and every one of those is an
entity. But a photograph library has two other axes that are at least as useful and considerably
more reliable: **when** it was taken and **where**. "The scenes from March to May" and "the Lisbon
trip" are natural, obvious queries that the specified model could not express.

**Second, four separate paths to the same outcome invites four implementations.** If the Companion
resolves a question one way and the World Index filters another way, they will diverge, and the
divergence will show up as the Companion being able to express something the UI cannot, or worse,
the two disagreeing about what "Julie and Leo together" means.

## Decision

**There is one Selection primitive. Every surface is an entry point that produces one, and nothing
else in the system knows where a Selection came from.**

A Selection is a set of constraints over the memory graph:

| Dimension | Contents | Semantics |
| --- | --- | --- |
| Entities | people, objects, places | ANY or ALL. ALL requires a shared evidence window, not merely co-presence in one capture |
| Time | one or more intervals over capture time | Derived from EXIF, so it covers every photograph including ones that can never be reconstructed |
| Place | place entities, or spatial clusters | Derived from EXIF GPS where present, from user labels, and from capture-supported signage |
| Capture | reconstruction rung, processing state | Lets the user ask for what is actually explorable |
| Epistemic | confirmed only, or include proposals | The system may organize on a guess but never assert on one, and the user chooses which they are looking at |

A Selection resolves deterministically to a set of evidence spans, the islands those spans touch,
and a **view manifest**, which is the existing structure that drives recomposition. Nothing about
this bypasses the query safety design: a Selection *is* the restricted declarative query plan that
`architecture-overview.md` section 5 already specifies, with time and place added as dimensions.

### Entry points, all equal

1. **The Companion.** A natural-language turn produces a proposed Selection, shown to the user
   before it is applied.
2. **The World Index.** Clicking a person, picking a date range, choosing a place.
3. **The Atlas Map.** Selecting a region or an island.
4. **Direct interaction.** `Interact` on a person or object in the Atlas.

### The Companion is not privileged

This is the load-bearing part. The Companion emits **the same validated plan** the UI emits, and it
goes through **the same server-side validation**. It has no special path to the graph and no ability
to express a filter the interface cannot.

This follows from a rule the architecture already states: the model must never generate executable
queries, only a restricted plan the server validates and executes deterministically. Making the
Companion one entry point among several is not a new constraint, it is that constraint applied
consistently.

The practical consequence is that anything the Companion can do is inspectable and repeatable in the
interface, and anything the interface can express can be reached conversationally. A user who
distrusts the conversational surface loses no capability, which matters for a product whose thesis
is that the user stays in control of what is asserted.

## Rationale

**Time and place are the most reliable dimensions in the entire system.** They come from EXIF, cost
no model calls, and are correct for effectively every photograph. Identity matching is a probabilistic
proposal that requires user confirmation; a timestamp is not. For a library of a few thousand travel
photographs, time and place filtering is what makes the Atlas navigable at all, and it works on the
large majority of images that will never support reconstruction.

**One primitive means one place to get the semantics right.** ANY versus ALL, and the rule that
"together" requires a shared evidence window rather than mere co-presence, are subtle and are
already specified. Implementing them once and reaching them from four surfaces is the only way they
stay consistent.

**It makes the demonstration stronger.** Filtering to a trip and a month and watching the Atlas
recompose around that subset is a more convincing demonstration than any single reconstructed room,
and it uses material that already exists rather than material that must be captured.

## Consequences

- The view manifest gains time and place as inputs. It still contains no field that can express a
  camera pose or a position, so a query still cannot move the user, which is the existing
  anti-disorientation guarantee.
- The World Index gains date-range and place filters, and becomes the primary surface on mobile,
  where Pointer Lock does not exist.
- Evaluation gains cases for time and place filter correctness alongside the existing ANY versus ALL
  person filters. See `evaluation-methodology.md`.
- **An island may be a cluster rather than a single capture.** With five curated captures, one
  island is one capture. With a few thousand travel photographs, that is thousands of islands and
  the Atlas becomes noise. The likely resolution is that an island is a place-on-a-trip cluster and
  individual photographs are shards within it, but this is **OPEN** until the real distribution of
  the corpus has been measured. It is recorded here because the Selection model must not assume
  one-island-per-capture.

## Rejected alternatives

**Separate filter mechanisms per surface.** Rejected because they diverge, and the divergence
surfaces as the Companion and the interface disagreeing about what a query meant.

**Time and place as search text rather than structured dimensions.** Rejected because it makes range
queries and clustering impossible, and because it would push interpretation into the model for data
that is exactly known.

**A conversational-first design where the Companion is the only way to filter.** Rejected because it
would make a probabilistic surface the sole route to a deterministic capability, and because it
fails on mobile where the World Index has to carry the product.
