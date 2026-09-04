"""The identity of a set of photographs a reconstruction was run over.

ADR-0009 D9: "A fact about a set needs a subject, and deletion has to reach it." Every artifact
before this is keyed to exactly one source blob, which is what the purge cascade and the export
projector join on. A pose receipt, a splat and a placement record are facts about N photographs
and have no home in that scheme, so they get a scene: an explicit identity with an explicit
many-to-many source relation, in migration 0024.

This module is the identity half and nothing else. It computes a digest and a uuid from a set of
capture ids, and it is deliberately in the pure core, below every layer that would want it: the
writer is in ``orimera.ingest``, which is what drives a reconstruction and holds the repository
that persists one, and the read is in ``orimera.graph``. Those two are siblings in the layering
contract and may not import each other, so a derivation living in either would be copied into the
other, and two copies of an identity rule is two identities.

**Not ``orimera.reconstruction``, and the reason is a contract rather than a preference.**
``orimera.reconstruction`` is forbidden from importing ``orimera.evidence`` at all, by the
import-linter contract named "Reconstruction cannot produce a citation, because it cannot name
one": invariant 2 is enforced by making the producer unable to construct an evidence address, so
no refactor inside it can produce one. A scene identity is not an evidence address, but the
contract is a blanket one on purpose, and the module that runs COLMAP is therefore the one module
that may not compute a scene id. It receives one. This module knows nothing about a database.

Three decisions in it.

**Over capture ids, and deliberately not over blob hashes.** Decision del-3 gives a re-imported
photograph a NEW ``capture_id``, precisely so that a user who deleted something and deliberately
re-imported it is not silently blocked. A scene keyed on bytes would resolve that re-import to
the same scene id and hand back the identity a tombstone withdrew, so deletion would be monotonic
for the photograph and not for the fact built from it. A capture id is a uuidv7 and is unique
across workspaces, so the sorted set separates workspaces on its own and the key carries none,
which is the arrangement ``artifact_id`` already has.

**The set is the set the job was GIVEN, not the set that registered.** Registration is an outcome
and lives on the member row, because a scene id has to be computable before the job runs, and
because a reconstruction that registered six of eight photographs is a fact about the eight it
was asked about. ADR-0009 D9's rung is derived from the registered subset; the subject is not.

**Length-prefixed and domain-separated, like the idempotency key and for its recorded reason.**
Version 1 of that key "concatenated variable-length fields with no framing, so ``("vision", 11)``
and ``("vision1", 1)`` hashed identically and two different stages could silently share one
artifact row". Capture ids are fixed at sixteen bytes, so that exact collision cannot happen
here; the framing is kept anyway, because the field that is not fixed width is the count, and a
digest whose injectivity depends on every future field staying fixed width is a digest waiting
for the field that is not.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterable
from typing import Final

__all__ = [
    "SCENE_DIGEST_VERSION",
    "SCENE_NAMESPACE",
    "scene_id_for",
    "scene_member_digest",
]

#: A fixed UUIDv5 namespace, so a scene id is a pure function of its members on every machine.
#: Generated once and frozen; changing it orphans every existing scene row and every artifact
#: that named one.
SCENE_NAMESPACE: Final = uuid.UUID("2b7c9e14-5d38-5a4f-8c61-7e0d9a3b5f28")

#: Bumped when the ENCODING of the digest changes, as distinct from the members that go into it.
#: Recorded in the digest rather than in a commit message, so a scene written under an older
#: encoding can be recognised as such rather than silently compared with a newer one.
SCENE_DIGEST_VERSION: Final = 1

#: Domain separation. This digest is not a hash of anything else in the system, and prefixing it
#: means it can never be confused with one.
_SCENE_DOMAIN: Final = b"orimera/reconstruction-scene"


def scene_member_digest(capture_ids: Iterable[uuid.UUID]) -> bytes:
    """The 32-byte digest of a member set, order independent and duplicate free.

    Sorted and de-duplicated before hashing, because the set is what identifies the scene and the
    order a caller happened to hold it in is not part of that. A caller that passed the same
    photograph twice asked about one photograph twice, which is the same scene.

    Raises :class:`ValueError` on an empty set. A scene of no photographs has no subject, and a
    digest over nothing is a name that every empty question would share. Migration 0024 makes the
    same refusal from the other side: ``tombstone_blocks_scene`` blocks a scene with no member
    rows, because a membership that cannot be seen and a membership that is not there are the
    same answer to a session that must fail closed.
    """
    members = sorted({capture_id for capture_id in capture_ids})
    if not members:
        raise ValueError("a scene is a set of photographs and cannot be empty")
    hasher = hashlib.sha256()
    for part in (
        _SCENE_DOMAIN,
        str(SCENE_DIGEST_VERSION).encode("ascii"),
        len(members).to_bytes(8, "big"),
        *(capture_id.bytes for capture_id in members),
    ):
        hasher.update(len(part).to_bytes(8, "big"))
        hasher.update(part)
    return hasher.digest()


def scene_id_for(capture_ids: Iterable[uuid.UUID]) -> uuid.UUID:
    """The deterministic ``scene_id`` of a member set.

    A uuid5 over the digest's hex, the same shape ``artifact_id_for`` uses over an idempotency
    key, so that two processes asked about the same photographs write the same row rather than a
    second one.
    """
    return uuid.uuid5(SCENE_NAMESPACE, scene_member_digest(capture_ids).hex())
