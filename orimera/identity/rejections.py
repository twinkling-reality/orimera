"""Has this pair, on this basis, already been refused, and what is new about the one asked now?

**Nothing here deletes a rejection.** ``identity_rejection`` has a ``revoked_at`` column and
:meth:`Rejections.revoke` sets it, because a deleted rejection leaves no evidence that the user
ever said no. Invariant 3 is a promise about not re-asking, and a promise the record cannot
witness is not one.

**A rejection is keyed by evidence and by basis.** ``key_a`` is the occurrence's evidence-derived
identity key rather than its row id, so a detector re-run does not forget. ``basis_digest`` says
which signal set was shown, so a genuinely better one may ask again. Drop either and the failure
is total in one direction or the other.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from orimera.identity.repository import IdentityRepository

__all__ = ["Rejections"]


class Rejections:
    """Reads and writes over ``identity_rejection``."""

    def __init__(self, repository: IdentityRepository) -> None:
        self._repository = repository

    def record(
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
        row = self._repository.connection.execute(
            "insert into identity_rejection (workspace_id, scope, key_a, key_b, basis_digest, "
            "rejected_by, basis_modalities) values (%s, %s, %s, %s, %s, %s, %s) "
            "on conflict (workspace_id, scope, key_a, key_b, basis_digest) do update "
            "set revoked_at = null, rejected_at = now(), rejected_by = excluded.rejected_by "
            "returning rejection_id",
            (
                self._repository.workspace_id,
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

    def covering(
        self, *, scope: str, key_a: bytes, key_b: bytes, modalities: Sequence[str]
    ) -> tuple[bool, str | None]:
        """Is this pair on this basis already refused, and if not, what is new about it?

        Decision id-4's rule is a SUBSET test: a proposal is suppressed when everything it is
        built on was already refused. ``X <@ Y`` is literally that. Digest equality, which is
        what :meth:`is_rejected` implements, is only the degenerate case, and it under-suppresses
        in the dangerous direction: ``basis_digest`` covers extractor versions, so bumping the
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
        rows = self._repository.connection.execute(
            "select basis_modalities from identity_rejection "
            "where workspace_id = %s and scope = %s and key_a = %s and key_b = %s "
            "  and revoked_at is null",
            (self._repository.workspace_id, scope, key_a, key_b),
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

    def is_rejected(
        self, *, scope: str, key_a: bytes, key_b: bytes, basis_digest: bytes
    ) -> bool:
        """Has this exact pairing, on this exact basis, already been refused?

        All four parts matter. Drop ``basis_digest`` and a genuinely better signal set can never
        re-ask; drop ``key_a``'s evidence derivation and every detector re-run forgets.

        The name is carried over from the one class this package used to have. Migration 0008's
        header calls ``IdentityRepository.is_rejected`` the degenerate digest-equality case that
        :meth:`covering` replaced, and an applied migration is not editable, so half of that
        reference is already stale: there is no such attribute now. Keeping the leaf name is
        what leaves the header's sentence findable by grep at all.
        """
        row = self._repository.connection.execute(
            "select 1 from identity_rejection where workspace_id = %s and scope = %s "
            "and key_a = %s and key_b = %s and basis_digest = %s and revoked_at is null",
            (self._repository.workspace_id, scope, key_a, key_b, basis_digest),
        ).fetchone()
        return row is not None

    def revoke(self, *, scope: str, key_a: bytes, key_b: bytes, basis_digest: bytes) -> int:
        """Undo a no. A revocation, never a removal: the row records that it was said."""
        cursor = self._repository.connection.execute(
            "update identity_rejection set revoked_at = now() where workspace_id = %s "
            "and scope = %s and key_a = %s and key_b = %s and basis_digest = %s "
            "and revoked_at is null",
            (self._repository.workspace_id, scope, key_a, key_b, basis_digest),
        )
        return cursor.rowcount

    def revoke_all(self, *, scope: str, key_a: bytes, key_b: bytes) -> list[uuid.UUID]:
        """Withdraw every live no about this pair, and say which ones were withdrawn.

        A user who refused a proposal and then confirmed the link has changed their mind about
        the pair, not about one basis. Leaving the other rejections live would suppress future
        proposals for a pair they have now confirmed.

        The ids are returned rather than discarded because undo has to be exact. Un-revoking
        "every rejection for this pair" would revive ones that were live before the confirm, and
        an undo that restores more than the action removed is not an undo.
        """
        rows = self._repository.connection.execute(
            "update identity_rejection set revoked_at = now() where workspace_id = %s "
            "and scope = %s and key_a = %s and key_b = %s and revoked_at is null "
            "returning rejection_id",
            (self._repository.workspace_id, scope, key_a, key_b),
        ).fetchall()
        return [row["rejection_id"] for row in rows]

    def revive(self, rejection_ids: Sequence[uuid.UUID]) -> int:
        """Put back exactly the rejections a confirm withdrew. Used only by undo."""
        if not rejection_ids:
            return 0
        cursor = self._repository.connection.execute(
            "update identity_rejection set revoked_at = null "
            "where workspace_id = %s and rejection_id = any(%s)",
            (self._repository.workspace_id, list(rejection_ids)),
        )
        return cursor.rowcount
