"""Identity: turning scene-local occurrences into people, and only ever with a person's say-so.

The rule this package exists to hold, from ``docs/domain-and-evidence-model.md``: a scene-local
occurrence is not a persistent entity, and promotion between them requires explicit user
confirmation. Model confidence is never user confirmation, and a rejected match is never
re-proposed identically.

Six modules, and the split between the last three is the one worth knowing:

*   :mod:`orimera.identity.keys` derives the two evidence-shaped keys a decision is recorded
    under, so that rejection memory survives a detector re-run.
*   :mod:`orimera.identity.repository` reads and writes the identity tables, and nothing else.
*   :mod:`orimera.identity.subjects` is what every decision shares: what can go wrong, and what a
    subject has to be for a decision to be about it.
*   :mod:`orimera.identity.decisions` applies one user decision as one transaction, and records
    what it did in ``identity_event`` so that undo is exact rather than approximate.
*   :mod:`orimera.identity.undo` is the inverse of each of those, in a handler table rather than
    a branch, so an event type nobody wrote an inverse for is refused by name instead of quietly
    doing nothing.
*   :mod:`orimera.identity.naming` renames an entity, which takes two writes and not one. Read
    its docstring before changing either of them.

**No embedding of any kind is derived here.** Open item P-1, "when may a biometric embedding
exist at all", is a human decision that has not been made, and every candidate rule in
``docs/privacy-consent-threat-model.md`` section 10 is a rule about persisting a template. This
package identifies people from what the account holder says, which needs no template and settles
nothing about P-1.
"""

from orimera.identity.decisions import (
    confirm_link,
    merge_entities,
    name_occurrence,
    reject_link,
    revoke_link,
    split_entity,
)
from orimera.identity.keys import (
    REGION_GRID,
    TIME_BUCKET_NS,
    USER_STATEMENT_BASIS,
    basis_digest,
    occurrence_identity_key,
    region_bucket,
)
from orimera.identity.naming import ConcurrentRename, RenamedEntity, rename_entity
from orimera.identity.repository import (
    EntityRow,
    IdentityRepository,
    LinkRow,
    OccurrenceRow,
)
from orimera.identity.subjects import (
    AlreadyIdentified,
    IdentityError,
    NamedPerson,
    NeverSame,
    NotUndoable,
    UnknownSubject,
)
from orimera.identity.undo import undo

__all__ = [
    "REGION_GRID",
    "TIME_BUCKET_NS",
    "USER_STATEMENT_BASIS",
    "AlreadyIdentified",
    "ConcurrentRename",
    "EntityRow",
    "IdentityError",
    "IdentityRepository",
    "LinkRow",
    "NamedPerson",
    "NeverSame",
    "NotUndoable",
    "OccurrenceRow",
    "RenamedEntity",
    "UnknownSubject",
    "basis_digest",
    "confirm_link",
    "merge_entities",
    "name_occurrence",
    "occurrence_identity_key",
    "region_bucket",
    "reject_link",
    "rename_entity",
    "revoke_link",
    "split_entity",
    "undo",
]
