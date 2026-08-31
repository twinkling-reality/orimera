"""A clean replay refuses existing state and archives an honest synthetic proof."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator

import psycopg
import pytest
from orimera.db import Database
from orimera.evaluation.bundle import AccessPurpose, CorpusBundle
from orimera.evaluation.provenance import verify_archive
from orimera.evaluation.replay import (
    CleanDatabaseError,
    assert_pristine_database,
    run_clean_replay,
)
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from conftest import CountingVisionModel, photo_bytes
from test_evaluation_bundle import _bundle


@pytest.fixture
def empty_replay_database() -> Iterator[Database]:
    base = os.environ.get("ORIMERA_TEST_DATABASE_URL")
    if not base:
        pytest.skip("set ORIMERA_TEST_DATABASE_URL to run the clean replay")
    configured = conninfo_to_dict(base)
    if "test" not in configured.get("dbname", ""):
        pytest.skip("refusing an admin URL whose database name does not contain test")
    name = f"orimera_replay_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    url = make_conninfo(base, dbname=name)
    try:
        yield Database(url)
    finally:
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(
                "select pg_terminate_backend(pid) from pg_stat_activity "
                "where datname = %s and pid <> pg_backend_pid()",
                (name,),
            )
            if not name.startswith("orimera_replay_test_"):
                raise AssertionError("refusing to drop an unexpected database")
            admin.execute(sql.SQL("drop database {}").format(sql.Identifier(name)))


def test_clean_replay_uses_a_new_database_and_keeps_the_gate_blocked(
    tmp_path, empty_replay_database
):
    payloads = {
        "train": photo_bytes(size=(160, 100)),
        "development": photo_bytes(size=(140, 100)),
        "blind": photo_bytes(size=(120, 100)),
    }
    root, secret = _bundle(
        tmp_path / "bundle",
        synthetic=True,
        source_payloads=payloads,
    )
    bundle = CorpusBundle.read(root)
    archives = tmp_path / "archives"
    archives.mkdir()

    before = assert_pristine_database(empty_replay_database)
    assert before["initial_user_relations"] == 0
    receipt = run_clean_replay(
        bundle=bundle,
        owner_database=empty_replay_database,
        runtime_database=empty_replay_database,
        data_dir=tmp_path / "data",
        audit_path=tmp_path / "access.jsonl",
        archive_parent=archives,
        repository_state={"commit": "1" * 40, "tree": "2" * 40, "dirty": False},
        purpose=AccessPurpose.BLIND_EVALUATION,
        actor="operator-fixture",
        blind_key=secret,
        vision=CountingVisionModel(),
        allow_unsafe_runtime_for_synthetic_test=True,
    )
    assert receipt.gate_passed is False
    assert any("synthetic" in blocker for blocker in receipt.blockers)
    assert any("label layers" in blocker for blocker in receipt.blockers)
    verify_archive(
        receipt.archive.path,
        expected_root_sha256=receipt.archive.root_sha256,
    )
    record = json.loads((receipt.archive.path / "record.json").read_text())
    assert record["database"]["initial_user_relations"] == 0
    assert record["database"]["runtime_role_enforced"] is False
    assert record["ingest"]["first_model_calls"] == 1
    assert record["ingest"]["replay_model_calls"] == 0
    assert record["execution_summary"]["reuse_events"] >= 2
    assert (receipt.archive.path / "access/source-access.jsonl").is_file()

    with pytest.raises(CleanDatabaseError, match="not empty"):
        assert_pristine_database(empty_replay_database)


def test_clean_replay_refuses_an_administrative_database(monkeypatch):
    class FakeConnection:
        def execute(self, query):
            assert "current_database" in query

            class Cursor:
                @staticmethod
                def fetchone():
                    return {
                        "database_name": "postgres",
                        "schema_name": "public",
                        "role_name": "owner",
                        "server_version": "18",
                    }

            return Cursor()

    class Context:
        def __enter__(self):
            return FakeConnection()

        def __exit__(self, *_args):
            return None

    monkeypatch.setattr(Database, "unscoped", lambda _self: Context())
    with pytest.raises(CleanDatabaseError, match="administrative database"):
        assert_pristine_database(Database("unused"))
