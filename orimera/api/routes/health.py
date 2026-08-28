"""Liveness and readiness, which are two signals and must not be one.

``deployment.md`` section 6 specifies both, and the distinction is not pedantry: the demonstration
has to survive roughly 46 days unattended, an external probe runs every five minutes, and the two
questions have different costs and different answers.

*   **Liveness**, ``GET /healthz``, costs nothing beyond the process itself and checks only
    that the process is running and can serve a request. No dependency is touched.
*   **Readiness**, ``GET /readyz``, costs one cheap query and one cheap object-store call, and
    checks that the dependencies a request actually needs are reachable.

Three things readiness must not do, from section 6.3, and each is implemented as an absence
rather than as a comment:

*   **It must not call a model.** 13,200 checks over the judging window, each spending roughly
    200 reasoning tokens before producing any output, and worse, health would then go red the
    day the prepaid balance ran out for a reason that has nothing to do with the service being
    up. There is no model call anywhere in this module.
*   **It must not claim more than it checks.** A 200 from ``/healthz`` says the process is
    alive. It does not say the reasoning model still exists in the catalog; that is the
    scheduled ``orimera-preflight`` run, and readiness reports the manifest parsing rather than
    the catalog agreeing.
*   **It must not be expensive enough to matter**, because a readiness check that is costly gets
    turned off or becomes the thing that falls over.

Neither endpoint is authorised, and that is the one deliberate exception to "every endpoint is
authorised". A liveness probe that needed a credential would be a liveness probe that goes red
when the credential rotates. Neither returns anything about the contents of any workspace.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from orimera.api.services import Services, describe_configuration
from orimera.db.migrate import applied_migrations
from orimera.migrations import migrations
from orimera.models.manifest import Role, load_manifest

router = APIRouter(tags=["health"])


@router.get("/healthz", summary="Liveness. Touches no dependency.")
def healthz() -> dict[str, str]:
    return {"status": "alive"}


@router.get("/readyz", summary="Readiness. One query, one object-store call, no model call.")
def readyz(request: Request, response: Response) -> dict[str, Any]:
    """Report each check separately, and return 503 when any of them fails.

    Separately, because a single boolean tells an operator at 3am that something is wrong and
    nothing about which thing. The checks are the four in section 6.2, and each one's entry says
    what it proves rather than only whether it passed.
    """
    services: Services = request.app.state.services
    checks: dict[str, Any] = {}

    checks["database"] = _database_check(services)
    checks["schema"] = _schema_check(services)
    checks["object_store"] = _store_check(services)
    checks["model_manifest"] = _manifest_check()

    ready = all(check["ok"] for check in checks.values())
    if not ready:
        response.status_code = 503
    return {
        "ready": ready,
        "checks": checks,
        "warnings": list(services.warnings),
        "configuration": describe_configuration(),
    }


def _database_check(services: Services) -> dict[str, Any]:
    """Proves the process is up and the pool is not exhausted. Proves nothing about the schema."""
    try:
        with services.database.unscoped() as connection:
            connection.execute("select 1")
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
    return {"ok": True, "proves": "the database is reachable and the connection pool is not full"}


def _schema_check(services: Services) -> dict[str, Any]:
    """Proves the running code and the running schema agree on a version.

    A mismatch here is the failure that otherwise surfaces much later as a wrong answer: two
    deployments claiming the same version with different tables.
    """
    expected = [migration.version for migration in migrations()]
    try:
        with services.database.unscoped() as connection:
            applied = sorted(applied_migrations(connection))
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
    if applied != expected:
        return {
            "ok": False,
            "detail": f"the database has {applied} and this code expects {expected}",
        }
    return {"ok": True, "applied": applied}


def _store_check(services: Services) -> dict[str, Any]:
    """Proves object storage is reachable and configuration points at the right place.

    Deliberately a single existence probe against a key that cannot exist rather than a listing.
    A listing is proportional to the corpus and this runs every five minutes.
    """
    from orimera.evidence.blob import BlobId

    try:
        services.store.exists(BlobId(b"\x00" * 32))
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
    return {"ok": True, "proves": "the store is reachable; nothing about any scene's completeness"}


def _manifest_check() -> dict[str, Any]:
    """Proves the application can name a model. Proves NOTHING about that model still existing.

    That gap is the whole reason ``orimera-preflight`` is a separate scheduled signal, and
    section 6.3 names it: "a green health check sitting in front of a withdrawn model".
    """
    try:
        manifest = load_manifest()
        resolved = {str(role): manifest[role].primary.model_id for role in Role}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
    return {
        "ok": True,
        "roles": resolved,
        "does_not_prove": "that any of these identifiers still exists in the live catalog. Run "
        "orimera-preflight on a schedule for that.",
    }
