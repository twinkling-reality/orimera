"""The corpus's ground truth, and the join that makes it usable.

``MANIFEST.json`` is keyed by the SHA-256 that ingest will compute, and that is the whole point:
an evaluation joins to a stored capture by EVIDENCE ADDRESS rather than by filename. A filename
is a thing a user renames; the content hash is what the system actually keys on, so a join on it
measures the system rather than a naming convention.

It also records ``instant_is_recoverable_from_the_file`` per frame, so the unknown-offset case
can be scored without crediting the pipeline for guessing. One device in the corpus writes
``OffsetTimeOriginal`` and one does not, and a frame from the second one has a wall-clock reading
in the file and no way to place it on a timeline. A pipeline that produced an instant for such a
frame would be inventing one, and this is what lets that be scored as a failure rather than as a
success nobody looked at.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
from dataclasses import dataclass
from typing import Any

__all__ = ["Frame", "GroundTruth"]


@dataclass(frozen=True, slots=True)
class Frame:
    """One frame of the corpus, as the generator recorded it."""

    filename: str
    sha256: str
    trip: str
    place: str
    device_model: str
    display_size: tuple[int, int]
    utc_instant: str | None
    instant_is_recoverable_from_the_file: bool
    gps_e7: tuple[int, int] | None
    subjects: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class GroundTruth:
    """The manifest, and what may be said about a number computed against it."""

    path: pathlib.Path
    manifest_sha256: str
    generator: str
    synthetic: bool
    disclosure: str
    frames: tuple[Frame, ...]
    trips: tuple[str, ...]
    places: tuple[str, ...]
    subjects: tuple[str, ...]

    @property
    def by_hash(self) -> dict[str, Frame]:
        """Frames keyed by the hash ingest computes, which is how the join is made."""
        return {frame.sha256: frame for frame in self.frames}

    @property
    def corpus_tag(self) -> str:
        return "SYNTH-1" if self.synthetic else "OGC-1"

    @classmethod
    def read(cls, directory: str | pathlib.Path) -> GroundTruth:
        path = pathlib.Path(directory) / "MANIFEST.json"
        raw = path.read_bytes()
        document: dict[str, Any] = json.loads(raw)
        return cls(
            path=path,
            manifest_sha256=hashlib.sha256(raw).hexdigest(),
            generator=str(document["generator"]),
            synthetic=bool(document["synthetic"]),
            disclosure=str(document["disclosure"]),
            trips=tuple(trip["key"] for trip in document["trips"]),
            places=tuple(document["places"]),
            subjects=tuple(document["subjects"]),
            frames=tuple(
                Frame(
                    filename=frame["filename"],
                    sha256=frame["sha256"],
                    trip=frame["trip"],
                    place=frame["place"],
                    device_model=frame["device"]["model"],
                    display_size=(frame["display_size"][0], frame["display_size"][1]),
                    utc_instant=frame.get("utc_instant"),
                    instant_is_recoverable_from_the_file=bool(
                        frame["instant_is_recoverable_from_the_file"]
                    ),
                    gps_e7=(
                        (frame["gps_e7"][0], frame["gps_e7"][1])
                        if frame.get("gps_e7")
                        else None
                    ),
                    subjects=tuple(frame.get("subjects", ())),
                )
                for frame in document["frames"]
            ),
        )


def instant_is_correct(frame: Frame, stored: str | None) -> tuple[bool, str]:
    """Did the pipeline place this frame on a timeline, and was it entitled to?

    Four cases and they are not symmetric. The one that matters is the fourth: a frame whose file
    carries no recoverable offset, for which the pipeline produced an instant anyway. That is not
    a near miss. It is an invented fact, and scoring it as a pass because the value happened to be
    right would be crediting a guess.
    """
    if frame.instant_is_recoverable_from_the_file:
        if stored is None:
            return False, "the file carries a recoverable instant and none was stored"
        if frame.utc_instant is None:
            return False, "the manifest says recoverable and records no instant"
        return (
            stored.startswith(frame.utc_instant[:19]),
            f"stored {stored!r} against {frame.utc_instant!r}",
        )
    if stored is None:
        return True, ""
    return False, (
        f"the file carries no recoverable offset and {stored!r} was stored anyway, which is an "
        "instant the pipeline guessed rather than read"
    )
