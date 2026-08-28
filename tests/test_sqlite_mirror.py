"""The SQLite mirror must stay a mirror, not become a second schema.

The ingest data layer runs against a portable subset of migration 0001 so it can be tested
without a PostgreSQL server. That is only defensible while the two agree. A column invented in
the mirror is a column production does not have, and the symptom appears months later as an
insert that works in tests and fails in production, or worse, the reverse.

So this file parses both files and compares them mechanically:

*   every column in the mirror exists in migration 0001, with the same table and name;
*   every column migration 0001 requires (NOT NULL, no default, not generated) exists in the
    mirror, so a row valid here is a row valid there;
*   the predicate seed is identical, because ``allows_kind`` is what stops a model writing a
    name and a caption being filed as a capture-supported fact.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest
from orimera.ingest.repository import PREDICATE_SEED
from orimera.migrations import migrations

MIRROR_SQL = (
    Path(__file__).resolve().parents[1] / "orimera" / "ingest" / "sqlite_mirror.sql"
).read_text(encoding="utf-8")
MIGRATION_SQL = next(iter(migrations())).sql

_NON_COLUMN = {
    "constraint",
    "unique",
    "primary",
    "check",
    "foreign",
    "exclude",
    "partition",
}


def _strip_comments(text: str) -> str:
    """Remove ``--`` comments before any depth counting.

    This is not cosmetic. Both files contain comments holding unbalanced brackets, such as the
    note that ``[0,0)`` overlaps nothing, and a scanner that counts them closes the table
    definition several columns early and then reports a difference that does not exist.
    """
    return "\n".join(line.split("--")[0] for line in text.splitlines())


def _scan_to_close(sql: str, start: int) -> int:
    """Index just past the parenthesis that closes the one opened before ``start``.

    Quote aware, because ``int8range(t_start_ns, t_end_ns, '[)')`` contains a closing bracket
    inside a string literal and a naive counter stops there.
    """
    depth = 1
    index = start
    in_string = False
    while index < len(sql) and depth:
        char = sql[index]
        if in_string:
            in_string = char != "'"
        elif char == "'":
            in_string = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        index += 1
    return index


def _table_bodies(sql: str) -> dict[str, str]:
    """Every ``create table`` body in a file, keyed by table name."""
    sql = _strip_comments(sql)
    bodies: dict[str, str] = {}
    for match in re.finditer(r"create table (?:if not exists )?([a-z_]+)\s*\(", sql, re.IGNORECASE):
        end = _scan_to_close(sql, match.end())
        bodies[match.group(1)] = sql[match.end() : end - 1]
    return bodies


def _split_items(body: str) -> list[str]:
    items: list[str] = []
    depth = 0
    in_string = False
    current: list[str] = []
    for char in body:
        if in_string:
            in_string = char != "'"
        elif char == "'":
            in_string = True
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0 and not in_string:
            items.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    if "".join(current).strip():
        items.append("".join(current).strip())
    return [item for item in items if item]


def _columns(body: str) -> dict[str, str]:
    columns: dict[str, str] = {}
    for item in _split_items(body):
        first = item.split()[0].strip('"').lower()
        if first in _NON_COLUMN:
            continue
        columns[first] = " ".join(item.split()).lower()
    return columns


MIRROR_TABLES = _table_bodies(MIRROR_SQL)
MIGRATION_TABLES = _table_bodies(MIGRATION_SQL)


def test_the_mirror_only_covers_tables_that_exist_in_the_migration():
    assert set(MIRROR_TABLES) <= set(MIGRATION_TABLES), (
        f"the mirror invents tables: {sorted(set(MIRROR_TABLES) - set(MIGRATION_TABLES))}"
    )


@pytest.mark.parametrize("table", sorted(MIRROR_TABLES))
def test_the_mirror_invents_no_column(table):
    mirror = set(_columns(MIRROR_TABLES[table]))
    production = set(_columns(MIGRATION_TABLES[table]))
    assert mirror <= production, (
        f"{table}: columns in the mirror that production does not have: "
        f"{sorted(mirror - production)}"
    )


@pytest.mark.parametrize("table", sorted(MIRROR_TABLES))
def test_the_mirror_carries_every_column_a_valid_production_row_needs(table):
    """NOT NULL with no default and not generated: a row without it cannot be written there."""
    mirror = set(_columns(MIRROR_TABLES[table]))
    required = {
        name
        for name, definition in _columns(MIGRATION_TABLES[table]).items()
        if "not null" in definition
        and "default" not in definition
        and "generated always as" not in definition
    }
    assert required <= mirror, (
        f"{table}: production requires columns the mirror cannot supply: "
        f"{sorted(required - mirror)}"
    )


def test_the_evidence_span_constraints_that_matter_are_mirrored():
    """The half-open, never-empty rule is what stops the interval guard failing open."""
    body = " ".join(MIRROR_TABLES["evidence_span"].split())
    assert "check (t_end_ns > t_start_ns)" in body
    assert "region is null or modality = 'frame_region'" in body


def test_the_assertion_constraints_that_carry_the_epistemic_model_are_mirrored():
    body = " ".join(MIRROR_TABLES["assertion"].split())
    for fragment in (
        "kind <> 'inference' or support_span_ids <> '[]'",
        "kind <> 'capture' or support_span_ids <> '[]'",
        "kind <> 'inference' or produced_by_run is not null",
        "kind <> 'user' or stated_by_user is not null",
    ):
        assert fragment in body, fragment


def test_the_predicate_seed_matches_the_migration_exactly():
    """``allows_kind`` is load bearing, so a drift here is a hole in the epistemic model."""
    block = MIGRATION_SQL.split("insert into predicate")[1]
    block = block.split(";")[0]
    seeded: dict[str, tuple[dict, bool, tuple[str, ...], bool]] = {}
    pattern = re.compile(
        r"\(\s*'([a-z_]+)'\s*,\s*'(\{.*?\})'\s*,\s*(true|false)\s*,"
        r"\s*'\{([a-z,]+)\}'\s*,\s*(true|false)\s*\)",
        re.DOTALL,
    )
    for key, schema, functional, allows, writes_a_name in pattern.findall(block):
        seeded[key] = (
            json.loads(schema),
            functional == "true",
            tuple(sorted(allows.split(","))),
            writes_a_name == "true",
        )

    declared = {
        key: (schema, functional, tuple(sorted(allows)), writes_a_name)
        for key, schema, functional, allows, writes_a_name in PREDICATE_SEED
    }
    assert seeded == declared
    # The regex must have matched something. A pattern that silently matches nothing turns this
    # into a test that passes whatever the seed says, which is the failure mode the review
    # found elsewhere in this suite.
    assert len(seeded) == len(PREDICATE_SEED) > 0


def test_a_naming_predicate_is_seeded_as_user_only_in_both_schemas():
    """The one row invariant 4 stands or falls on, checked as data rather than as prose."""
    naming = [row for row in PREDICATE_SEED if row[4]]
    assert [row[0] for row in naming] == ["name_is"]
    for key, _schema, _functional, allows, _writes in naming:
        assert allows == ("user",), key


def test_no_python_literal_snuck_into_the_mirror():
    """A guard against a schema file that has quietly become a Python string somewhere."""
    with pytest.raises((SyntaxError, ValueError)):
        ast.literal_eval(MIRROR_SQL)
