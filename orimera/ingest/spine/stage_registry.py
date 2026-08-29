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
    """Upsert one row per stage. ``model_ref`` carries the role, never a model identifier."""
    for key, spec in specs.items():
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
