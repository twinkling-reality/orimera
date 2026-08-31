"""What each stage was when it ran, recorded so the ledger can be read without the source.

``stage_registry`` has no ``workspace_id``: a stage's version and parameters are a property of
the deployment, not of one person's corpus. It still takes a scope, like everything in this
package, because the scope is how a connection is reached here at all.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from psycopg.types.json import Jsonb

from orimera.ingest.spine.scope import WorkspaceScope

__all__ = ["register"]


def register(scope: WorkspaceScope, specs: Mapping[str, Any]) -> None:
    """Register reviewed definitions additively, then move each stage's current pointer.

    ``stage_definition`` is the replay-safe history. ``stage_registry`` remains the convenient
    current pointer used by existing readers. A parameter edit may keep the semantic version but
    gets its own definition digest, which is deliberate: the vision prompt digest is a parameter
    so forgetting to bump a version cannot silently preserve old results.
    """
    for key, spec in specs.items():
        scope.connection.execute(
            "insert into stage_definition (stage_key, stage_version, params_digest, params, "
            "model_role, deterministic, output_kind, review_status) "
            "values (%s, %s, %s, %s, %s, %s, %s, 'reviewed') "
            "on conflict (stage_key, stage_version, params_digest) do nothing",
            (
                key,
                spec.version,
                spec.params_digest,
                Jsonb(spec.params),
                spec.model_role,
                spec.deterministic,
                spec.output_kind,
            ),
        )
        scope.connection.execute(
            "insert into stage_registry (stage_key, current_version, model_ref, "
            "params_schema, deterministic, output_kind, updated_at) "
            "values (%s, %s, %s, %s, %s, %s, now()) "
            "on conflict (stage_key) do update set "
            "current_version = excluded.current_version, model_ref = excluded.model_ref, "
            "params_schema = excluded.params_schema, "
            "deterministic = excluded.deterministic, "
            "output_kind = excluded.output_kind, updated_at = excluded.updated_at",
            (
                key,
                spec.version,
                Jsonb({"role": spec.model_role}) if spec.model_role else None,
                Jsonb(spec.params),
                spec.deterministic,
                spec.output_kind,
            ),
        )
