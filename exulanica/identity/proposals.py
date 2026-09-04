"""What did the producer ask, and which of those questions is still waiting for an answer?

The two halves are read from two different places on purpose. What was asked is
``match_proposal``, including the questions that were discarded, because "we considered this and
did not show it" is the part of the record that explains why a user is not being asked about
somebody they already answered about. What is still open is the ``pending_match_proposal`` view,
because ``outcome`` records what the PRODUCER decided and whether a question is still open is a
fact about the user's later decisions.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from psycopg.types.json import Jsonb

if TYPE_CHECKING:
    from exulanica.identity.repository import IdentityRepository

__all__ = ["Proposals"]


class Proposals:
    """Writes over ``match_proposal``, reads over ``pending_match_proposal``."""

    def __init__(self, repository: IdentityRepository) -> None:
        self._repository = repository

    def record(
        self,
        *,
        occurrence_id: uuid.UUID,
        entity_id: uuid.UUID,
        score: float,
        rank: int,
        basis_digest: bytes,
        basis: dict[str, Any],
        outcome: str,
        produced_by_run: uuid.UUID,
        emit_key: str,
        new_modality: str | None = None,
    ) -> uuid.UUID | None:
        """A candidate, including the ones that were discarded.

        A proposal suppressed by rejection memory is still written, with the outcome saying so.
        Returns None when ``emit_key`` was already recorded, which is how a re-run of the
        producer asks no question twice.
        """
        row = self._repository.connection.execute(
            "insert into match_proposal (workspace_id, occurrence_id, entity_id, score, rank, "
            "basis_digest, basis, outcome, produced_by_run, emit_key, new_modality) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "on conflict (workspace_id, emit_key) do nothing returning proposal_id",
            (
                self._repository.workspace_id,
                occurrence_id,
                entity_id,
                score,
                rank,
                basis_digest,
                Jsonb(basis),
                outcome,
                produced_by_run,
                emit_key,
                new_modality,
            ),
        ).fetchone()
        return None if row is None else row["proposal_id"]

    def pending(
        self, *, occurrence_id: uuid.UUID, entity_id: uuid.UUID
    ) -> dict[str, Any] | None:
        """The open question about this pair, or None when there is not one.

        One definition of "open", and the graph's open-question count reads the same view, so the
        number on screen and the check on confirm cannot disagree.
        """
        return self._repository.connection.execute(
            "select proposal_id, basis, basis_digest, new_modality from pending_match_proposal "
            "where workspace_id = %s and occurrence_id = %s and entity_id = %s",
            (self._repository.workspace_id, occurrence_id, entity_id),
        ).fetchone()
