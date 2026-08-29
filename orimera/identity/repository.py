"""Reads and writes over the identity tables, and nothing else.

The transactional operations live in :mod:`orimera.identity.decisions`. This module is rows: it
knows how an entity, a link, a rejection and an event are stored, and it knows nothing about
what sequence of them constitutes a merge.

Two things it deliberately cannot do:

*   **Write a name.** :meth:`set_display_name` exists, but the database refuses it unless an
    active ``kind='user'`` assertion under a naming predicate already says so
    (``tg_entity_name_is_user_stated``, migration 0002). So the only route to a name is through
    :func:`orimera.identity.decisions.name_occurrence`, which writes the assertion first, and a
    caller reaching for this method directly gets a refusal rather than a name.
*   **Delete a rejection.** ``identity_rejection`` has a ``revoked_at`` column and no delete
    path here, because undo is a revocation. A deleted rejection leaves no evidence that the
    user ever said no.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from orimera.db.session import set_workspace

__all__ = [
    "EntityRow",
    "IdentityRepository",
    "LinkRow",
    "OccurrenceRow",
    "ProposalRow",
]


@dataclass(frozen=True, slots=True)
class EntityRow:
    entity_id: uuid.UUID
    entity_class: str
    display_name: str | None
    merged_into: uuid.UUID | None
    deleted_at: Any


@dataclass(frozen=True, slots=True)
class OccurrenceRow:
    occurrence_id: uuid.UUID
    capture_id: uuid.UUID
    occurrence_class: str
    primary_span_id: uuid.UUID
    span_ids: tuple[uuid.UUID, ...]
    identity_key: bytes


@dataclass(frozen=True, slots=True)
class LinkRow:
    link_id: uuid.UUID
    occurrence_id: uuid.UUID
    entity_id: uuid.UUID
    state: str
    method: str
    basis_digest: bytes
    decided_by: uuid.UUID | None


@dataclass(frozen=True, slots=True)
class ProposalRow:
    proposal_id: uuid.UUID
    occurrence_id: uuid.UUID
    entity_id: uuid.UUID
    score: float
    rank: int
    outcome: str


class IdentityRepository:
    """Every identity table, in one place."""

    def __init__(self, connection: psycopg.Connection, workspace_id: uuid.UUID) -> None:
        self._db = connection
        self._db.row_factory = dict_row
        self.workspace_id = workspace_id
        # Same reason as IngestRepository: the guards assert the session's workspace matches the
        # row being written, and row-level security makes an unscoped connection see an empty
        # database rather than raise.
        set_workspace(connection, workspace_id)

    @property
    def connection(self) -> psycopg.Connection:
        return self._db

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Connection]:
        """One decision lands together or not at all.

        Not a convenience. A merge that half-applied would leave entities pointing at a target
        that no event records, and the ledger would no longer describe the state.
        """
        with self._db.transaction():
            yield self._db

    # -- occurrences --------------------------------------------------------------------

    def occurrence(self, occurrence_id: uuid.UUID) -> OccurrenceRow | None:
        row = self._db.execute(
            "select occurrence_id, capture_id, class, primary_span_id, span_ids, identity_key "
            "from occurrence where workspace_id = %s and occurrence_id = %s",
            (self.workspace_id, occurrence_id),
        ).fetchone()
        return None if row is None else self._occurrence(row)

    def occurrences_of(self, entity_id: uuid.UUID) -> list[OccurrenceRow]:
        """Every occurrence confirmed to be this entity, in insertion order.

        Confirmed only. An ``auto_provisional`` link may drive layout and filtering and may
        never support a factual claim, so a caller asking "where has this person been" gets the
        confirmed set and has to ask separately for the guesses.
        """
        rows = self._db.execute(
            "select o.occurrence_id, o.capture_id, o.class, o.primary_span_id, o.span_ids, "
            "o.identity_key from occurrence o "
            "join entity_link l on l.occurrence_id = o.occurrence_id "
            "where o.workspace_id = %s and l.entity_id = %s and l.state = 'confirmed' "
            "order by o.occurrence_id",
            (self.workspace_id, entity_id),
        ).fetchall()
        return [self._occurrence(row) for row in rows]

    @staticmethod
    def _occurrence(row: Mapping[str, Any]) -> OccurrenceRow:
        return OccurrenceRow(
            occurrence_id=row["occurrence_id"],
            capture_id=row["capture_id"],
            occurrence_class=row["class"],
            primary_span_id=row["primary_span_id"],
            span_ids=tuple(row["span_ids"]),
            identity_key=bytes(row["identity_key"]),
        )

    # -- entities -----------------------------------------------------------------------

    def create_entity(self, *, entity_class: str) -> uuid.UUID:
        """A new entity, unnamed. There is no argument for a name and that is deliberate."""
        row = self._db.execute(
            "insert into entity (workspace_id, class) values (%s, %s) returning entity_id",
            (self.workspace_id, entity_class),
        ).fetchone()
        assert row is not None
        return row["entity_id"]

    def entity(self, entity_id: uuid.UUID) -> EntityRow | None:
        row = self._db.execute(
            "select entity_id, class, display_name, merged_into, deleted_at from entity "
            "where workspace_id = %s and entity_id = %s",
            (self.workspace_id, entity_id),
        ).fetchone()
        return None if row is None else self._entity(row)

    def entities(self, *, entity_class: str | None = None) -> list[EntityRow]:
        rows = self._db.execute(
            "select entity_id, class, display_name, merged_into, deleted_at from entity "
            "where workspace_id = %s and deleted_at is null "
            "and (%s::text is null or class::text = %s) order by entity_id",
            (self.workspace_id, entity_class, entity_class),
        ).fetchall()
        return [self._entity(row) for row in rows]

    def resolve_entity(self, entity_id: uuid.UUID) -> uuid.UUID:
        """Follow ``merged_into`` to the entity that now represents this one.

        A merge is an alias redirect rather than a rewrite of every link, so a link written
        before the merge still names the old entity and still has to resolve. The walk is
        bounded: a cycle would be a bug in the merge path rather than something to survive, so
        it raises rather than looping.
        """
        seen: list[uuid.UUID] = []
        current = entity_id
        while True:
            row = self._db.execute(
                "select merged_into from entity where workspace_id = %s and entity_id = %s",
                (self.workspace_id, current),
            ).fetchone()
            if row is None or row["merged_into"] is None:
                return current
            if current in seen:
                raise RuntimeError(f"merged_into cycle through {current}: {seen}")
            seen.append(current)
            current = row["merged_into"]

    def set_display_name(self, entity_id: uuid.UUID, display_name: str | None) -> None:
        """Set the cached name. Refused by trigger unless an active user assertion says so."""
        self._db.execute(
            "update entity set display_name = %s where workspace_id = %s and entity_id = %s",
            (display_name, self.workspace_id, entity_id),
        )

    def set_merged_into(self, entity_id: uuid.UUID, target: uuid.UUID | None) -> None:
        self._db.execute(
            "update entity set merged_into = %s where workspace_id = %s and entity_id = %s",
            (target, self.workspace_id, entity_id),
        )

    # -- links --------------------------------------------------------------------------

    def insert_link(
        self,
        *,
        occurrence_id: uuid.UUID,
        entity_id: uuid.UUID,
        state: str,
        method: str,
        basis_digest: bytes,
        decided_by: uuid.UUID | None = None,
        score: float | None = None,
    ) -> uuid.UUID:
        """Write a link. ``confirmed`` is refused by CHECK unless a human decided it.

        ``confirmed_needs_a_human`` in migration 0001 requires ``decided_by is not null and
        method = 'user_confirm'``, so no argument combination reachable from a model can produce
        a confirmed link.
        """
        row = self._db.execute(
            "insert into entity_link (workspace_id, occurrence_id, entity_id, state, method, "
            "score, basis_digest, decided_by, decided_at) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, "
            "case when %s::uuid is null then null else now() end) returning link_id",
            (
                self.workspace_id,
                occurrence_id,
                entity_id,
                state,
                method,
                score,
                basis_digest,
                decided_by,
                decided_by,
            ),
        ).fetchone()
        assert row is not None
        return row["link_id"]

    def link_for_occurrence(
        self, occurrence_id: uuid.UUID, *, states: Sequence[str] = ("confirmed",)
    ) -> LinkRow | None:
        row = self._db.execute(
            "select link_id, occurrence_id, entity_id, state, method, basis_digest, decided_by "
            "from entity_link where workspace_id = %s and occurrence_id = %s "
            "and state = any(%s::link_state[]) order by created_at desc limit 1",
            (self.workspace_id, occurrence_id, list(states)),
        ).fetchone()
        return None if row is None else self._link(row)

    def links_of(
        self, entity_id: uuid.UUID, *, states: Sequence[str] = ("confirmed",)
    ) -> list[LinkRow]:
        rows = self._db.execute(
            "select link_id, occurrence_id, entity_id, state, method, basis_digest, decided_by "
            "from entity_link where workspace_id = %s and entity_id = %s "
            "and state = any(%s::link_state[]) order by link_id",
            (self.workspace_id, entity_id, list(states)),
        ).fetchall()
        return [self._link(row) for row in rows]

    def set_link_state(self, link_id: uuid.UUID, state: str) -> None:
        self._db.execute(
            "update entity_link set state = %s where workspace_id = %s and link_id = %s",
            (state, self.workspace_id, link_id),
        )

    @staticmethod
    def _link(row: Mapping[str, Any]) -> LinkRow:
        return LinkRow(
            link_id=row["link_id"],
            occurrence_id=row["occurrence_id"],
            entity_id=row["entity_id"],
            state=row["state"],
            method=row["method"],
            basis_digest=bytes(row["basis_digest"]),
            decided_by=row["decided_by"],
        )

    # -- rejection memory ---------------------------------------------------------------

    def record_rejection(
        self,
        *,
        scope: str,
        key_a: bytes,
        key_b: bytes,
        basis_digest: bytes,
        rejected_by: uuid.UUID,
        basis_modalities: Sequence[str] | None = None,
    ) -> uuid.UUID:
        """Remember a no. Re-recording the same no revives it rather than duplicating it.

        ``basis_modalities`` is what the user was SHOWN, and None is a different fact from an
        empty list rather than a missing value. None means they were shown no machine signal and
        spoke unprompted about their own photograph, which suppresses every later proposal for
        the pair. An empty list would suppress none, so migration 0008 refuses one.
        """
        row = self._db.execute(
            "insert into identity_rejection (workspace_id, scope, key_a, key_b, basis_digest, "
            "rejected_by, basis_modalities) values (%s, %s, %s, %s, %s, %s, %s) "
            "on conflict (workspace_id, scope, key_a, key_b, basis_digest) do update "
            "set revoked_at = null, rejected_at = now(), rejected_by = excluded.rejected_by "
            "returning rejection_id",
            (
                self.workspace_id,
                scope,
                key_a,
                key_b,
                basis_digest,
                rejected_by,
                list(basis_modalities) if basis_modalities is not None else None,
            ),
        ).fetchone()
        assert row is not None
        return row["rejection_id"]

    def rejection_covering(
        self, *, scope: str, key_a: bytes, key_b: bytes, modalities: Sequence[str]
    ) -> tuple[bool, str | None]:
        """Is this pair on this basis already refused, and if not, what is new about it?

        Decision id-4's rule is a SUBSET test: a proposal is suppressed when everything it is
        built on was already refused. ``X <@ Y`` is literally that. Digest equality, which is
        what ``is_rejected`` implements, is only the degenerate case, and it under-suppresses in
        the dangerous direction: ``basis_digest`` covers extractor versions, so bumping the
        producer's version moves the digest while the modality set stands still and every
        rejected proposal comes back. Asking the user again is exactly the failure invariant 3
        names.

        A rejection with NULL modalities is the account holder speaking about their own
        photograph having been shown nothing. It covers every basis, because no machine signal
        outranks that.

        Returns ``(suppressed, new_modality)``. The second is what this proposal carries that the
        user has not already refused, which is what lets an interface say why it is asking again
        rather than appearing to nag.
        """
        wanted = list(modalities)
        rows = self._db.execute(
            "select basis_modalities from identity_rejection "
            "where workspace_id = %s and scope = %s and key_a = %s and key_b = %s "
            "  and revoked_at is null",
            (self.workspace_id, scope, key_a, key_b),
        ).fetchall()
        if not rows:
            return False, None
        refused: set[str] = set()
        for row in rows:
            if row["basis_modalities"] is None:
                return True, None
            refused.update(row["basis_modalities"])
        if set(wanted) <= refused:
            return True, None
        fresh = sorted(set(wanted) - refused)
        return False, fresh[0] if fresh else None

    def revoke_all_rejections(self, *, scope: str, key_a: bytes, key_b: bytes) -> list[uuid.UUID]:
        """Withdraw every live no about this pair, and say which ones were withdrawn.

        A user who refused a proposal and then confirmed the link has changed their mind about
        the pair, not about one basis. Leaving the other rejections live would suppress future
        proposals for a pair they have now confirmed.

        The ids are returned rather than discarded because undo has to be exact. Un-revoking
        "every rejection for this pair" would revive ones that were live before the confirm, and
        an undo that restores more than the action removed is not an undo.
        """
        rows = self._db.execute(
            "update identity_rejection set revoked_at = now() where workspace_id = %s "
            "and scope = %s and key_a = %s and key_b = %s and revoked_at is null "
            "returning rejection_id",
            (self.workspace_id, scope, key_a, key_b),
        ).fetchall()
        return [row["rejection_id"] for row in rows]

    def revive_rejections(self, rejection_ids: Sequence[uuid.UUID]) -> int:
        """Put back exactly the rejections a confirm withdrew. Used only by undo."""
        if not rejection_ids:
            return 0
        cursor = self._db.execute(
            "update identity_rejection set revoked_at = null "
            "where workspace_id = %s and rejection_id = any(%s)",
            (self.workspace_id, list(rejection_ids)),
        )
        return cursor.rowcount

    def is_rejected(
        self, *, scope: str, key_a: bytes, key_b: bytes, basis_digest: bytes
    ) -> bool:
        """Has this exact pairing, on this exact basis, already been refused?

        All four parts matter. Drop ``basis_digest`` and a genuinely better signal set can never
        re-ask; drop ``key_a``'s evidence derivation and every detector re-run forgets.
        """
        row = self._db.execute(
            "select 1 from identity_rejection where workspace_id = %s and scope = %s "
            "and key_a = %s and key_b = %s and basis_digest = %s and revoked_at is null",
            (self.workspace_id, scope, key_a, key_b, basis_digest),
        ).fetchone()
        return row is not None

    def revoke_rejection(
        self, *, scope: str, key_a: bytes, key_b: bytes, basis_digest: bytes
    ) -> int:
        """Undo a no. A revocation, never a delete: the row records that it was said."""
        cursor = self._db.execute(
            "update identity_rejection set revoked_at = now() where workspace_id = %s "
            "and scope = %s and key_a = %s and key_b = %s and basis_digest = %s "
            "and revoked_at is null",
            (self.workspace_id, scope, key_a, key_b, basis_digest),
        )
        return cursor.rowcount

    # -- never-same ---------------------------------------------------------------------

    def record_never_same(
        self, a: uuid.UUID, b: uuid.UUID, *, created_by_event: uuid.UUID | None = None
    ) -> None:
        """These two are not the same person. Stored once, with ``entity_a < entity_b``."""
        low, high = sorted((a, b))
        self._db.execute(
            "insert into never_same (workspace_id, entity_a, entity_b, created_by_event) "
            "values (%s, %s, %s, %s) on conflict (workspace_id, entity_a, entity_b) do nothing",
            (self.workspace_id, low, high, created_by_event),
        )

    def is_never_same(self, a: uuid.UUID, b: uuid.UUID) -> bool:
        low, high = sorted((a, b))
        row = self._db.execute(
            "select 1 from never_same where workspace_id = %s and entity_a = %s and entity_b = %s",
            (self.workspace_id, low, high),
        ).fetchone()
        return row is not None

    def forget_never_same(self, a: uuid.UUID, b: uuid.UUID) -> int:
        """Only an undo of the split that wrote it may do this."""
        low, high = sorted((a, b))
        cursor = self._db.execute(
            "delete from never_same where workspace_id = %s and entity_a = %s and entity_b = %s",
            (self.workspace_id, low, high),
        )
        return cursor.rowcount

    # -- proposals ----------------------------------------------------------------------

    def record_proposal(
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
        "We considered this and did not show it" is the part of the record that explains why a
        user is not being asked about someone they already answered about.
        """
        row = self._db.execute(
            "insert into match_proposal (workspace_id, occurrence_id, entity_id, score, rank, "
            "basis_digest, basis, outcome, produced_by_run, emit_key, new_modality) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "on conflict (workspace_id, emit_key) do nothing returning proposal_id",
            (
                self.workspace_id,
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

    def pending_proposal(
        self, *, occurrence_id: uuid.UUID, entity_id: uuid.UUID
    ) -> dict[str, Any] | None:
        """The open question about this pair, or None when there is not one.

        Read from ``pending_match_proposal`` rather than from ``match_proposal``, because
        ``outcome`` records what the PRODUCER decided and whether the question is still open is a
        fact about the user's later decisions. One definition, and the graph's open-question
        count reads the same view, so the number on screen and the check on confirm cannot
        disagree.
        """
        return self._db.execute(
            "select proposal_id, basis, basis_digest, new_modality from pending_match_proposal "
            "where workspace_id = %s and occurrence_id = %s and entity_id = %s",
            (self.workspace_id, occurrence_id, entity_id),
        ).fetchone()

    def proposals_for(self, occurrence_id: uuid.UUID) -> list[ProposalRow]:
        rows = self._db.execute(
            "select proposal_id, occurrence_id, entity_id, score, rank, outcome "
            "from match_proposal where workspace_id = %s and occurrence_id = %s order by rank",
            (self.workspace_id, occurrence_id),
        ).fetchall()
        return [
            ProposalRow(
                proposal_id=row["proposal_id"],
                occurrence_id=row["occurrence_id"],
                entity_id=row["entity_id"],
                score=row["score"],
                rank=row["rank"],
                outcome=row["outcome"],
            )
            for row in rows
        ]

    # -- the identity event log ---------------------------------------------------------

    def record_event(
        self,
        event_type: str,
        *,
        actor: uuid.UUID,
        payload: dict[str, Any],
        undoes: uuid.UUID | None = None,
    ) -> uuid.UUID:
        """Append one identity event. The payload is what makes undo exact.

        A merge that recorded only "a and b became c" could be undone approximately; a merge
        that records the exact link set at merge time can be undone to the state that existed.
        """
        row = self._db.execute(
            "insert into identity_event (workspace_id, type, actor, payload, undoes) "
            "values (%s, %s, %s, %s, %s) returning event_id",
            (self.workspace_id, event_type, actor, Jsonb(payload), undoes),
        ).fetchone()
        assert row is not None
        return row["event_id"]

    def event(self, event_id: uuid.UUID) -> dict[str, Any] | None:
        return self._db.execute(
            "select event_id, type, actor, payload, undoes, created_at from identity_event "
            "where workspace_id = %s and event_id = %s",
            (self.workspace_id, event_id),
        ).fetchone()

    def undo_of(self, event_id: uuid.UUID) -> uuid.UUID | None:
        """The event that undid this one, if any. Undoing twice is a bug, not a no-op."""
        row = self._db.execute(
            "select event_id from identity_event where workspace_id = %s and undoes = %s "
            "limit 1",
            (self.workspace_id, event_id),
        ).fetchone()
        return None if row is None else row["event_id"]

    def events(self, *, limit: int = 50) -> list[dict[str, Any]]:
        return self._db.execute(
            "select event_id, type, actor, payload, undoes, created_at from identity_event "
            "where workspace_id = %s order by created_at desc, event_id desc limit %s",
            (self.workspace_id, limit),
        ).fetchall()

    # -- recomputation ------------------------------------------------------------------

    def mark_derived_stale(self, dependencies: Sequence[str]) -> int:
        """Flag every derived artifact that depended on any of these, and say how many.

        ``dep_index`` is the flattened ``'entity:<uuid>'`` form with a GIN index over it,
        precisely so invalidation is a query rather than a hand-maintained list of things to
        remember. A generated title naming somebody has to become stale when that person is
        merged away, or the name survives its own deletion inside a caption.
        """
        if not dependencies:
            return 0
        cursor = self._db.execute(
            "update derived_artifact set stale = true where workspace_id = %s "
            "and dep_index && %s::text[] and not stale",
            (self.workspace_id, list(dependencies)),
        )
        return cursor.rowcount

    @staticmethod
    def _entity(row: Mapping[str, Any]) -> EntityRow:
        return EntityRow(
            entity_id=row["entity_id"],
            entity_class=row["class"],
            display_name=row["display_name"],
            merged_into=row["merged_into"],
            deleted_at=row["deleted_at"],
        )
