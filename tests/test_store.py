"""The content-addressed store: idempotent writes, verified reads, and no casual delete."""

from __future__ import annotations

import io

import pytest
from orimera.errors import (
    BlobNotFoundError,
    ImmutableKeyError,
    IntegrityError,
    PurgeNotAuthorisedError,
)
from orimera.evidence import BlobId
from orimera.store import (
    ContentAddressedStore,
    LocalContentAddressedStore,
    PurgeAuthorization,
    privileged_purger,
)


@pytest.fixture
def store(tmp_path) -> LocalContentAddressedStore:
    return LocalContentAddressedStore(tmp_path / "blobs")


# -- the refusal that matters ------------------------------------------------------------------


def test_the_store_refuses_a_casual_delete():
    """There is no delete on the normal write path, and there is nothing to call.

    This is structural rather than documented on purpose. A store that merely declines to
    delete can be talked into it; a store with no such method cannot, whatever a caller is
    asked to do by a prompt-injected annotation or a tired afternoon.
    """
    for forbidden in ("delete", "remove", "purge", "unlink", "clear", "destroy", "truncate"):
        assert not hasattr(ContentAddressedStore, forbidden)
        assert not hasattr(LocalContentAddressedStore, forbidden)


def test_erasure_exists_but_only_with_an_explicit_authorisation(store):
    blob = store.put_bytes(b"a photograph").blob_id
    assert store.exists(blob)

    with pytest.raises(PurgeNotAuthorisedError):
        privileged_purger(store, None)  # type: ignore[arg-type]
    with pytest.raises(PurgeNotAuthorisedError):
        PurgeAuthorization(tombstone_id="", actor="ops", reason="user request")
    with pytest.raises(PurgeNotAuthorisedError):
        PurgeAuthorization(tombstone_id="t-1", actor="ops", reason="   ")

    purger = privileged_purger(
        store,
        PurgeAuthorization(tombstone_id="t-1", actor="ops", reason="capture tombstone"),
    )
    assert purger.purge(blob) is True
    assert not store.exists(blob)
    # Idempotent, so a resumed purge job is safe.
    assert purger.purge(blob) is False


def test_a_store_without_a_privileged_path_cannot_be_escalated():
    class ReadOnlyBackend(ContentAddressedStore):
        def key_for(self, blob_id):
            return blob_id.hex

        def put_bytes(self, data):
            raise NotImplementedError

        def put_stream(self, stream):
            raise NotImplementedError

        def put_file(self, path):
            raise NotImplementedError

        def get(self, blob_id):
            raise NotImplementedError

        def open(self, blob_id):
            raise NotImplementedError

        def exists(self, blob_id):
            return False

        def size(self, blob_id):
            raise NotImplementedError

        def iter_blob_ids(self):
            return iter(())

    with pytest.raises(PurgeNotAuthorisedError):
        privileged_purger(
            ReadOnlyBackend(),
            PurgeAuthorization(tombstone_id="t-1", actor="ops", reason="r"),
        )


# -- content addressing ------------------------------------------------------------------------


def test_a_write_is_keyed_by_the_hash_of_its_own_bytes(store):
    payload = b"waterfall, winter, behind"
    result = store.put_bytes(payload)
    assert result.blob_id == BlobId.of_bytes(payload)
    assert result.byte_size == len(payload)
    assert result.created is True
    assert store.get(result.blob_id) == payload


def test_re_uploading_identical_bytes_is_free_and_does_not_rewrite(store):
    """Deduplication is the mechanism that stops a re-ingest re-billing every derivative."""
    first = store.put_bytes(b"same bytes")
    second = store.put_bytes(b"same bytes")
    assert first.blob_id == second.blob_id
    assert first.created is True
    assert second.created is False
    assert list(store.iter_blob_ids()) == [first.blob_id]


def test_different_bytes_never_share_a_key(store):
    a = store.put_bytes(b"photograph one")
    b = store.put_bytes(b"photograph two")
    assert a.blob_id != b.blob_id
    assert store.key_for(a.blob_id) != store.key_for(b.blob_id)
    assert sorted(store.iter_blob_ids()) == sorted([a.blob_id, b.blob_id])


def test_the_key_layout_is_an_object_key_an_s3_backend_could_serve(store):
    blob = BlobId.of_bytes(b"anything")
    key = store.key_for(blob)
    assert key == f"sha-256/{blob.hex[:2]}/{blob.hex[2:4]}/{blob.hex}"
    assert not key.startswith("/")


def test_streaming_and_in_memory_writes_agree(store):
    payload = b"y" * (2 * (1 << 20) + 3)
    streamed = store.put_stream(io.BytesIO(payload))
    assert streamed.blob_id == BlobId.of_bytes(payload)
    assert streamed.byte_size == len(payload)
    assert store.size(streamed.blob_id) == len(payload)


def test_put_file_streams_from_disk(store, tmp_path):
    source = tmp_path / "photo.jpg"
    source.write_bytes(b"jpeg bytes")
    assert store.put_file(source).blob_id == BlobId.of_bytes(b"jpeg bytes")


# -- integrity ---------------------------------------------------------------------------------


def test_a_read_verifies_that_the_key_is_still_true(store):
    """The key is a claim about the content. A read that stopped checking would let a
    corrupted or swapped object masquerade as the evidence a citation points at."""
    blob = store.put_bytes(b"original bytes").blob_id
    path = store.root / store.key_for(blob)
    path.chmod(0o644)
    path.write_bytes(b"tampered bytes")
    with pytest.raises(IntegrityError):
        store.get(blob)


@pytest.mark.parametrize("substitute", [b"a different length entirely", b"tampered bytes"])
def test_a_key_holding_different_content_is_never_absorbed_as_an_overwrite(store, substitute):
    """Including the same-length substitution, which a size check alone would wave through."""
    original = b"original bytes"
    blob = store.put_bytes(original).blob_id
    path = store.root / store.key_for(blob)
    path.chmod(0o644)
    path.write_bytes(substitute)
    if len(substitute) == len(original):
        assert path.stat().st_size == len(original)  # the size check would have passed
    with pytest.raises(ImmutableKeyError):
        store.put_bytes(original)


def test_a_missing_blob_raises_rather_than_returning_empty(store):
    with pytest.raises(BlobNotFoundError):
        store.get(BlobId.of_bytes(b"never stored"))
