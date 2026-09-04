"""Forward-only SQL migrations, and the checksums the application verifies at boot.

Migrations are numbered, plain SQL, one file per migration, each wrapped in its own
transaction. There are no down migrations: a mistake is corrected by a new forward file.

The checksum matters more than it looks. An edited migration is a silent schema fork: two
deployments claim the same version and have different tables, and the difference shows up much
later as a wrong answer rather than as an error. ``verify_applied`` is what lets a service
refuse to start on drift instead of discovering it that way.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

__all__ = ["Migration", "migration_directory", "migrations", "verify_applied"]

_MIGRATION_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


@dataclass(frozen=True, slots=True, order=True)
class Migration:
    """One migration file, identified by its numeric version."""

    version: str
    path: Path

    @property
    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")

    @property
    def checksum(self) -> bytes:
        """SHA-256 of the file bytes, exactly as they are on disk."""
        return hashlib.sha256(self.path.read_bytes()).digest()


def migration_directory() -> Path:
    return Path(__file__).resolve().parent


def migrations() -> Iterator[Migration]:
    """Yield every migration in version order."""
    for path in sorted(migration_directory().glob("*.sql")):
        match = _MIGRATION_RE.match(path.name)
        if match is None:
            raise ValueError(
                f"{path.name} does not match NNNN_lower_snake.sql; migration ordering is by "
                "filename, so an unparseable name is an ordering bug waiting to happen"
            )
        yield Migration(version=match.group(1), path=path)


def verify_applied(applied: dict[str, bytes]) -> None:
    """Compare recorded checksums against the files on disk, or raise.

    ``applied`` is ``{version: checksum}`` read from ``schema_migrations``. Every applied
    version must still exist on disk with the identical checksum. Unapplied files are fine;
    they are pending. An applied version that is missing or altered is drift.
    """
    on_disk = {migration.version: migration.checksum for migration in migrations()}
    problems: list[str] = []
    for version, checksum in sorted(applied.items()):
        if version not in on_disk:
            problems.append(f"{version}: applied to the database but absent from the package")
        elif on_disk[version] != checksum:
            problems.append(
                f"{version}: checksum drift, database has {checksum.hex()[:16]}..., "
                f"file hashes to {on_disk[version].hex()[:16]}..."
            )
    if problems:
        raise RuntimeError("schema drift, refusing to start:\n  " + "\n  ".join(problems))
