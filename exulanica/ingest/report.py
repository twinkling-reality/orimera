"""What an ingest run did, per file and per directory.

Separate from the pipeline because the stages record into it and the pipeline hands it to
them: with these types living in ``pipeline.py``, a stage module could not name the thing it
writes without importing the module that imports it.

The distinctions here are the point of the file. "Nothing was recomputed", "something was never
computed" and "something failed" are three different states, and a report that collapses them
is how a corpus quietly ends up with no observations in it while every run says it succeeded.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from exulanica.evidence.blob import BlobId

__all__ = ["IngestOutcome", "IngestReport"]


@dataclass
class IngestOutcome:
    """What happened to one file."""

    path: Path
    blob_id: BlobId | None = None
    capture_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    stages_run: list[str] = field(default_factory=list)
    stages_reused: list[str] = field(default_factory=list)
    stages_skipped: list[str] = field(default_factory=list)
    #: Reviewed stages that could not run because their configured implementation or input was
    #: unavailable. Kept beside ``stages_skipped`` for compatibility with existing summaries;
    #: the durable ledger records the sharper state.
    stages_unavailable: list[str] = field(default_factory=list)
    model_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    usd_estimate: Decimal = Decimal("0")
    error: str | None = None
    failure_class: str | None = None
    retryable: bool = False
    missing: bool = False
    unavailable: bool = False
    #: True when the run stopped because the user had deleted these bytes. A separate fact from
    #: ``error``, which it also sets: "the user deleted this" and "this broke" are different
    #: things and only one of them is worth retrying. The ledger has recorded the distinction
    #: since 0001, as ``cancelled`` against ``failed``, and this is the same distinction on the
    #: way back out so a caller does not have to read the message to recover it.
    tombstoned: bool = False

    @property
    def unchanged(self) -> bool:
        """True when nothing new was computed: every stage resolved from an existing artifact."""
        return self.error is None and not self.stages_run

    @property
    def incomplete(self) -> bool:
        """True when a stage did not run at all, so this capture is not fully processed.

        Distinct from ``unchanged``. "Nothing was recomputed" and "something was never computed"
        are different states, and reporting them as one is how a corpus quietly ends up with no
        observations at all.
        """
        return self.error is None and bool(self.stages_skipped)


@dataclass
class IngestReport:
    """The summary a repeated directory run prints."""

    pipeline_digest: str
    outcomes: list[IngestOutcome] = field(default_factory=list)
    #: The watched intake this run belonged to, and what the formation stream is addressed by.
    #: None for an unwatched run, which is a real state rather than a missing value.
    batch_id: uuid.UUID | None = None

    @property
    def ingested(self) -> list[IngestOutcome]:
        return [o for o in self.outcomes if o.error is None and not o.unchanged]

    @property
    def unchanged(self) -> list[IngestOutcome]:
        return [o for o in self.outcomes if o.unchanged]

    @property
    def failed(self) -> list[IngestOutcome]:
        return [o for o in self.outcomes if o.error is not None]

    @property
    def incomplete(self) -> list[IngestOutcome]:
        return [o for o in self.outcomes if o.incomplete]

    @property
    def model_calls(self) -> int:
        return sum(o.model_calls for o in self.outcomes)
