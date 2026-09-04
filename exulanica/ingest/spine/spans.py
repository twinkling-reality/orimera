"""The evidence address as a row: content hash, track key, exact interval, and nothing else.

This is invariant 1 in table form. Everything about the address that the digest covers is a
column here, and the digest is stored beside them so a row read back can be rebuilt and compared
rather than trusted.
"""

from __future__ import annotations

import uuid

from psycopg.types.json import Jsonb

from orimera.db.guards import terminal_if_tombstoned
from orimera.evidence import EvidenceAddress
from orimera.ingest.spine.scope import WorkspaceScope

__all__ = ["upsert"]


def upsert(scope: WorkspaceScope, address: EvidenceAddress) -> uuid.UUID:
    """Persist an address, or return the id of the identical one already stored.

    Deduplication is on ``span_digest``, which is a pure function of the address, so two stages
    that cite the same evidence share one row without coordinating. The insert is attempted
    first and the read is the fallback, rather than the other way round, because read-then-insert
    loses the race to a concurrent writer and this does not.
    """
    digest_input = address.as_digest_input()
    with terminal_if_tombstoned():
        row = scope.connection.execute(
            "insert into evidence_span (span_format_version, workspace_id, blob_sha256, "
            "track_key, t_start_ns, t_end_ns, modality, region, text_anchor, span_digest) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "on conflict (workspace_id, span_digest) do nothing returning span_id",
            (
                address.span_format_version,
                scope.workspace_id,
                address.blob_id.digest,
                address.track_key,
                address.interval.start_ns,
                address.interval.end_ns,
                str(address.modality),
                Jsonb(digest_input["region"]) if "region" in digest_input else None,
                Jsonb(digest_input["text_anchor"]) if "text_anchor" in digest_input else None,
                address.span_digest,
            ),
        ).fetchone()
    if row is not None:
        return row["span_id"]
    existing = scope.connection.execute(
        "select span_id from evidence_span where workspace_id = %s and span_digest = %s",
        (scope.workspace_id, address.span_digest),
    ).fetchone()
    assert existing is not None
    return existing["span_id"]
