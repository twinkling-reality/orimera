"""The evidence address: identity, round-tripping, and survival across regeneration."""

from __future__ import annotations

import uuid

import pytest
from orimera.errors import InvalidAddressError, LossyAddressError
from orimera.evidence import (
    PHOTOGRAPH_INTERVAL,
    BlobId,
    DisplayGeometry,
    EvidenceAddress,
    Modality,
    Rect,
    Region,
    TextAnchor,
    TimeInterval,
    parse_uri,
)

PHOTO_BYTES = b"\xff\xd8\xff\xe0 pretend this is a jpeg of a waterfall"
BLOB = BlobId.of_bytes(PHOTO_BYTES)
DISPLAY = DisplayGeometry(w=4032, h=3024, rotation=0, sar_num=1, sar_den=1)


def a_face_region() -> Region:
    return Region(rect=Rect.from_normalised(0.312, 0.220, 0.184, 0.401), display=DISPLAY)


# -- the degenerate photograph case ------------------------------------------------------------


def test_a_photograph_carries_a_real_non_empty_interval():
    address = EvidenceAddress.photograph(BLOB)
    assert address.track_key == "img"
    assert address.interval == PHOTOGRAPH_INTERVAL
    assert address.modality is Modality.STILL_IMAGE


def test_a_photograph_round_trips_through_the_address_form():
    address = EvidenceAddress.photograph(BLOB)
    parsed = parse_uri(address.to_uri())
    assert parsed == address
    assert parsed.span_digest == address.span_digest
    assert parsed.to_uri() == address.to_uri()


def test_a_region_in_a_photograph_round_trips_including_its_display_space():
    address = EvidenceAddress.photograph(BLOB, region=a_face_region())
    assert address.modality is Modality.FRAME_REGION
    parsed = parse_uri(address.to_uri())
    assert parsed == address
    assert parsed.region is not None
    assert parsed.region.rect == address.region.rect
    assert parsed.region.display == DISPLAY


@pytest.mark.parametrize(
    "address",
    [
        EvidenceAddress.photograph(BLOB),
        EvidenceAddress.photograph(BLOB, region=a_face_region()),
        EvidenceAddress(
            BLOB, "v:0", TimeInterval(12_500_000_000, 18_250_000_000), Modality.VIDEO_TIME
        ),
        EvidenceAddress(BLOB, "a:1", TimeInterval(0, 1_000_000_000), Modality.AUDIO_TIME),
        EvidenceAddress(
            BLOB, "v:0", TimeInterval(1, 2), Modality.FRAME_REGION, region=a_face_region()
        ),
        EvidenceAddress(
            BLOB,
            "a:0",
            TimeInterval(0, 2_000_000_000),
            Modality.TRANSCRIPT_TEXT,
            text_anchor=TextAnchor(uuid.UUID(int=7), 4120, 4190, exact="behind the waterfall"),
        ),
    ],
)
def test_every_citation_kind_round_trips_losslessly(address):
    assert parse_uri(address.to_uri()) == address


def test_the_documented_short_uri_form_still_parses():
    """The domain document renders a span without v= or m=. Those strings must stay readable."""
    uri = f"orimera://blob/{BLOB.ni_uri}/v:0#t=12.5,18.25"
    parsed = parse_uri(uri)
    assert parsed.modality is Modality.VIDEO_TIME
    assert parsed.interval == TimeInterval(12_500_000_000, 18_250_000_000)
    assert parsed.span_format_version == 1


def test_a_single_time_point_is_not_an_address():
    with pytest.raises(InvalidAddressError):
        parse_uri(f"orimera://blob/{BLOB.ni_uri}/v:0#t=12.5")


def test_a_region_uri_without_its_display_space_is_refused():
    """display is inside span_digest, so a URI that dropped it would parse to a different span."""
    with pytest.raises(InvalidAddressError):
        parse_uri(
            f"orimera://blob/{BLOB.ni_uri}/img#t=0,0.000000001&xywh=percent:31.2,22.0,18.4,40.1"
        )


def test_an_unrenderably_long_quote_refuses_rather_than_dropping_a_digest_input():
    address = EvidenceAddress(
        BLOB,
        "a:0",
        TimeInterval(0, 1),
        Modality.TRANSCRIPT_TEXT,
        text_anchor=TextAnchor(uuid.UUID(int=7), 0, 900, exact="word " * 400),
    )
    with pytest.raises(LossyAddressError):
        address.to_uri()
    assert address.to_uri(allow_lossy=True)  # explicit opt-in still renders


# -- collision resistance of the address -------------------------------------------------------


def test_two_different_byte_sequences_never_share_an_address():
    other = BlobId.of_bytes(PHOTO_BYTES + b"!")
    assert other != BLOB
    assert EvidenceAddress.photograph(other) != EvidenceAddress.photograph(BLOB)
    assert (
        EvidenceAddress.photograph(other).span_digest
        != EvidenceAddress.photograph(BLOB).span_digest
    )


def test_every_field_of_the_address_reaches_the_digest():
    """A regression that quietly dropped a field from the digest would collapse distinct spans.

    Two addresses that differ in exactly one digest input must produce different digests. This
    catches the specific failure of forgetting to include modality, or the display geometry, or
    the character range, when the digest tuple is edited.
    """
    base = EvidenceAddress(BLOB, "v:0", TimeInterval(0, 1_000), Modality.VIDEO_TIME)
    variants = [
        EvidenceAddress(
            BlobId.of_bytes(b"other"), "v:0", TimeInterval(0, 1_000), Modality.VIDEO_TIME
        ),
        EvidenceAddress(BLOB, "v:1", TimeInterval(0, 1_000), Modality.VIDEO_TIME),
        EvidenceAddress(BLOB, "v:0", TimeInterval(1, 1_000), Modality.VIDEO_TIME),
        EvidenceAddress(BLOB, "v:0", TimeInterval(0, 1_001), Modality.VIDEO_TIME),
        EvidenceAddress(
            BLOB, "v:0", TimeInterval(0, 1_000), Modality.FRAME_REGION, region=a_face_region()
        ),
        EvidenceAddress(
            BLOB,
            "v:0",
            TimeInterval(0, 1_000),
            Modality.FRAME_REGION,
            region=Region(rect=Rect.from_normalised(0.313, 0.220, 0.184, 0.401), display=DISPLAY),
        ),
        EvidenceAddress(
            BLOB,
            "v:0",
            TimeInterval(0, 1_000),
            Modality.FRAME_REGION,
            region=Region(
                rect=a_face_region().rect, display=DisplayGeometry(w=4032, h=3024, rotation=90)
            ),
        ),
        EvidenceAddress(
            BLOB,
            "a:0",
            TimeInterval(0, 1_000),
            Modality.TRANSCRIPT_TEXT,
            text_anchor=TextAnchor(uuid.UUID(int=1), 0, 10, exact="a"),
        ),
        EvidenceAddress(
            BLOB,
            "a:0",
            TimeInterval(0, 1_000),
            Modality.TRANSCRIPT_TEXT,
            text_anchor=TextAnchor(uuid.UUID(int=1), 0, 10, exact="b"),
        ),
    ]
    digests = {base.span_digest, *(v.span_digest for v in variants)}
    assert len(digests) == len(variants) + 1


def test_a_one_part_per_million_difference_in_a_region_is_a_different_address():
    left = EvidenceAddress.photograph(BLOB, region=Region(Rect(100, 100, 100, 100), DISPLAY))
    right = EvidenceAddress.photograph(BLOB, region=Region(Rect(101, 100, 100, 100), DISPLAY))
    assert left != right


# -- the invariant this whole design exists to protect ------------------------------------------


class DerivativePipeline:
    """A stand-in for the derivative layer: captions, OCR, keyframe indexes, embeddings.

    Every one of these is regenerated, some of them weekly. None of them may be reachable from
    an address, which is why this class can bump its version freely below.
    """

    def __init__(self) -> None:
        self.stage_version = 1
        self.artifacts: dict[str, uuid.UUID] = {}

    def run(self, blob: BlobId) -> None:
        self.artifacts[f"caption:{blob.hex}"] = uuid.uuid4()
        self.artifacts[f"keyframes:{blob.hex}"] = uuid.uuid4()

    def bump(self, blob: BlobId) -> None:
        self.stage_version += 1
        self.run(blob)


def test_a_citation_address_survives_regeneration_of_every_derivative():
    """A full pipeline regeneration must change zero evidence addresses.

    The address is (bytes, track, interval). Nothing a derivative produces, and nothing a
    derivative's version number touches, is an input to it. This is the property the whole
    epistemic layer is built on: if it failed, every stored citation token, permalink and
    archived answer would silently rot on the next model upgrade.
    """
    pipeline = DerivativePipeline()
    pipeline.run(BLOB)
    issued = [
        EvidenceAddress.photograph(BLOB),
        EvidenceAddress.photograph(BLOB, region=a_face_region()),
    ]
    before = [(a.span_digest, a.to_uri()) for a in issued]

    for _ in range(5):
        pipeline.bump(BLOB)

    # Same original bytes, so the address is reconstructed identically from scratch.
    rebuilt = [
        EvidenceAddress.photograph(BlobId.of_bytes(PHOTO_BYTES)),
        EvidenceAddress.photograph(BlobId.of_bytes(PHOTO_BYTES), region=a_face_region()),
    ]
    assert [(a.span_digest, a.to_uri()) for a in rebuilt] == before
    assert rebuilt == issued
    assert [parse_uri(uri) for _, uri in before] == issued


def test_the_address_has_no_field_a_derivative_could_move():
    """Frame ordinals and byte offsets are hints, and hints live on the row, not the address."""
    fields = set(EvidenceAddress.__slots__)
    for forbidden in ("hint", "span_id", "frame_ordinal", "byte_start", "byte_end", "artifact_id"):
        assert forbidden not in fields


# -- shape rules ---------------------------------------------------------------------------------


def test_a_transcript_span_must_carry_a_media_time_range_and_an_anchor():
    with pytest.raises(InvalidAddressError):
        EvidenceAddress(BLOB, "a:0", TimeInterval(0, 1), Modality.TRANSCRIPT_TEXT)


def test_a_region_makes_a_span_frame_region_and_nothing_else():
    with pytest.raises(InvalidAddressError):
        EvidenceAddress(
            BLOB, "img", PHOTOGRAPH_INTERVAL, Modality.STILL_IMAGE, region=a_face_region()
        )


def test_a_modality_may_not_address_the_wrong_track_kind():
    with pytest.raises(InvalidAddressError):
        EvidenceAddress(BLOB, "a:0", TimeInterval(0, 1), Modality.STILL_IMAGE)
    with pytest.raises(InvalidAddressError):
        EvidenceAddress(BLOB, "img", PHOTOGRAPH_INTERVAL, Modality.VIDEO_TIME)


def test_an_unknown_span_format_version_is_refused_rather_than_guessed():
    with pytest.raises(InvalidAddressError):
        EvidenceAddress(
            BLOB, "img", PHOTOGRAPH_INTERVAL, Modality.STILL_IMAGE, span_format_version=2
        )


def test_addresses_are_hashable_and_totally_ordered():
    a = EvidenceAddress.photograph(BLOB)
    b = EvidenceAddress(BLOB, "v:0", TimeInterval(0, 5), Modality.VIDEO_TIME)
    assert len({a, b, EvidenceAddress.photograph(BLOB)}) == 2
    assert sorted([b, a]) == sorted([a, b])
    assert (a < b) != (b < a)
