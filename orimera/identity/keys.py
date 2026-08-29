"""The keys identity decisions are recorded under, all derived from evidence.

Two keys live here, and neither is allowed to be a row id.

*   The **occurrence identity key** says WHICH thing in WHICH photograph a decision was about.
*   The **basis digest** says WHAT SIGNALS were shown when the decision was made.

Rejection memory is keyed on the pair, and that is what makes "never re-propose this" mean the
right thing. Keyed on the occurrence key alone, a genuinely better signal set could never
re-ask. Keyed on the row id, every detector re-run resurrects every rejection.

This module sits in ``orimera.identity`` rather than in ``orimera.ingest`` because the key is an
identity concept that ingest happens to need. Ingest creates occurrences and therefore computes
their keys; nothing about the definition belongs to the pipeline.

The occurrence identity key: derived from the evidence, never from a pipeline row.

This is the part that is normally got wrong, and getting it wrong has a specific symptom. If a
rejection is keyed by ``occurrence_id``, the next detector run mints a new ``occurrence_id`` for
the same thing in the same photograph, the rejected proposal comes straight back, and the user
re-rejects the same match forever. The product feels broken and the cause is invisible.

So the key is a function of the address:

    sha256(blob_sha256, track_key, floor(t_start/250ms), floor(t_end/250ms), class, region
    bucket on a 16x16 grid)

For a photograph both time buckets are zero, so the key reduces to blob, track, class and
region bucket, and it is stable across detector versions by construction.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from typing import Final

from orimera.canonical import sha256_of_canonical
from orimera.evidence import EvidenceAddress
from orimera.evidence.region import PPM, Rect

__all__ = [
    "BASIS_VOCABULARY",
    "PRODUCIBLE_MODALITIES",
    "REGION_GRID",
    "TIME_BUCKET_NS",
    "USER_STATEMENT_BASIS",
    "basis_digest",
    "normalise_modalities",
    "occurrence_identity_key",
    "region_bucket",
]

#: The closed basis vocabulary from decision id-4. Migration 0008 puts these identical six
#: strings in a CHECK on ``identity_rejection.basis_modalities`` and on
#: ``match_proposal.new_modality``, so a seventh added here and not there is refused by the
#: database on its first write rather than accepted and discovered later. That is R4's lesson
#: applied to a second vocabulary: one nothing enforces is held up by whoever edits it next.
BASIS_VOCABULARY: Final = frozenset(
    {"face", "voice", "gait", "context_place", "context_cooccurrence", "user_text"}
)

#: The three that have a producer. ``face``, ``voice`` and ``gait`` stay in the vocabulary above
#: because a rejection recorded under one must remain READABLE if one ever exists; they are
#: absent here because nothing may WRITE one. There is no face model and the decision that would
#: permit a face embedding belongs to a human and has not been made; the corpus is photographs so
#: there is no audio for voice; gait needs video. Nothing here settles any of that.
PRODUCIBLE_MODALITIES: Final = frozenset(
    {"context_place", "context_cooccurrence", "user_text"}
)


def normalise_modalities(modalities: Sequence[str]) -> tuple[str, ...]:
    """Sorted, distinct, every member from the closed vocabulary, or refuse.

    Sorted and distinct because the re-proposal rule is a subset test over a stored array, and
    two spellings of one set would compare unequal, fail to suppress, and ask the user a question
    they have already answered.
    """
    ordered = tuple(sorted(set(modalities)))
    if not ordered:
        raise ValueError("a proposal has a basis or it is not a proposal; modalities was empty")
    outside = [name for name in ordered if name not in BASIS_VOCABULARY]
    if outside:
        raise ValueError(
            f"{outside} is not in the id-4 basis vocabulary {sorted(BASIS_VOCABULARY)}. "
            "Migration 0008 refuses it at the database too."
        )
    return ordered

#: 250 ms, per the domain model. Constant for a photograph corpus; present so the video path
#: needs no second implementation.
TIME_BUCKET_NS: Final = 250_000_000
#: A 16x16 grid over the normalised image. Coarse on purpose: the point is that two runs of
#: two detector versions land in the same cell, not that the cell is precise.
REGION_GRID: Final = 16


def region_bucket(rect: Rect | None) -> str:
    """The grid cell a region falls in, or ``'null'`` for a whole-image occurrence.

    Bucketed by the box centre rather than its origin. A detector version that trims a box
    tightly moves the origin by more than it moves the centre, and the whole purpose of the
    bucket is to survive exactly that.
    """
    if rect is None:
        return "null"
    centre_x = rect.x_ppm + rect.w_ppm // 2
    centre_y = rect.y_ppm + rect.h_ppm // 2
    column = min(REGION_GRID - 1, centre_x * REGION_GRID // PPM)
    row = min(REGION_GRID - 1, centre_y * REGION_GRID // PPM)
    return f"{column}:{row}"


def occurrence_identity_key(address: EvidenceAddress, occurrence_class: str) -> bytes:
    """32 bytes derived only from the evidence address and the occurrence class."""
    rect = address.region.rect if address.region is not None else None
    parts = (
        address.blob_id.hex,
        address.track_key,
        str(address.interval.start_ns // TIME_BUCKET_NS),
        str(address.interval.end_ns // TIME_BUCKET_NS),
        occurrence_class,
        region_bucket(rect),
    )
    hasher = hashlib.sha256()
    for part in parts:
        # Length-prefixed, so ('ab', 'c') and ('a', 'bc') cannot collide. A concatenation
        # without separators is a collision waiting for a label that contains the separator.
        hasher.update(len(part).to_bytes(4, "big"))
        hasher.update(part.encode("utf-8"))
    return hasher.digest()


def basis_digest(
    modalities: Sequence[str], extractor_versions: Mapping[str, str] | None = None
) -> bytes:
    """Which signals a decision was shown, as 32 bytes. Never which decision was made.

    ``entity_link.basis_digest`` and ``identity_rejection.basis_digest`` both hold this, and the
    reason they hold the same thing is the rule about re-proposing. A rejection says "not on
    this evidence"; if the system later has a genuinely different basis, a fresh proposal is
    honest rather than nagging, and the digest is what tells the two apart. So an extractor
    version belongs in here and a score does not: the score is the output of the signals, and
    keying on it would make every reranking a licence to re-ask.

    Modalities are sorted, so the digest does not depend on the order a caller listed them.
    """
    if not modalities:
        raise ValueError("a decision has a basis or it is not a decision; modalities was empty")
    return sha256_of_canonical(
        {
            "modalities": sorted(modalities),
            "extractor_versions": dict(sorted((extractor_versions or {}).items())),
        }
    )


#: The basis of a decision the account holder made by looking at their own photograph. There is
#: no extractor and there is no model: the signal is a person saying so, which is the only signal
#: this system treats as knowledge rather than as a guess.
#:
#: ``user_statement`` is deliberately NOT a member of ``BASIS_VOCABULARY``. That vocabulary names
#: the machine signals a proposal can be built from, and a person looking at their own photograph
#: is not one of them: it is the absence of one. The corresponding
#: ``identity_rejection.basis_modalities`` is NULL rather than a list, which is what makes such a
#: rejection suppress everything afterwards instead of nothing.
USER_STATEMENT_BASIS: Final = basis_digest(["user_statement"])
