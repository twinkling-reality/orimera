"""A number, and the one place a number becomes text.

``docs/evaluation-methodology.md`` section 3 is nine mechanically enforceable rules about what
may be claimed from a measurement. Most of them are about rendering, so most of them live here,
in one renderer, because a rule delegated to every caller is a rule one caller will forget.

The three that shape the types:

*   **Rule 2.** "Any metric with a model in the loop runs at least three times. Report median and
    range. A single run of a stochastic system is not a measurement." ``Count`` cannot hold a
    median, so there are two result shapes and ``Sample`` refuses to be built from fewer than
    three runs. The refusal is in the type rather than in the caller, because the caller is where
    "just this once" gets written.
*   **Rule 3.** Below ten observations, print the individual cases rather than a percentage.
*   **Rule 4.** A failure is named with its evidence, or it is not reported. ``NamedCase``
    refuses a failure with no evidence.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

__all__ = ["SMALL_N", "Count", "NamedCase", "Sample", "render", "wilson"]

#: Section 2.0 rule 3. At or above this many observations an interval is meaningful; below it,
#: the cases themselves are the honest report.
SMALL_N: Final = 10

_Z_95: Final = 1.959963984540054


@dataclass(frozen=True, slots=True)
class NamedCase:
    """One scored case. A failure carries the evidence that it failed.

    Section 3.1 rule 4: a failure reported without the case that produced it is a number nobody
    can check, and the only thing anybody can do with it is believe it.
    """

    name: str
    passed: bool
    evidence: str = ""

    def __post_init__(self) -> None:
        if not self.passed and not self.evidence:
            raise ValueError(
                f"case {self.name!r} failed and carries no evidence. Rule 4: a failure is named "
                "with what produced it, or it is not reported."
            )


@dataclass(frozen=True, slots=True)
class Count:
    """One deterministic pass over the corpus. k of n, with every case named."""

    k: int
    n: int
    cases: tuple[NamedCase, ...] = ()


@dataclass(frozen=True, slots=True)
class Sample:
    """Three or more runs of a component with a model in the loop, per rule 2."""

    runs: tuple[Count, ...]

    def __post_init__(self) -> None:
        if len(self.runs) < 3:
            raise ValueError(
                f"{len(self.runs)} run(s): rule 2 requires at least three for a component with a "
                "model in the loop. Report median and range, or report nothing."
            )


def wilson(k: int, n: int) -> tuple[float, float]:
    """The 95% Wilson score interval, two-sided, stdlib only.

    CONVENTION NOTE, because the methodology is not self-consistent and this had to be chosen
    rather than read off. It prints three worked intervals and they do not agree with one
    another: its CIT-ID example reproduces exactly under two-sided Wilson, and its other two
    match no standard interval this was checked against. Two-sided Wilson is chosen because it is
    what rule 1 names and it reproduces the one example that reproduces at all. The other two are
    open items against the document, and this code must not be bent to hit them.

    Raises on ``n = 0`` rather than returning ``[0, 1]``. A zero must say which zero it is, and
    ``[0, 1]`` renders "nothing was scored" and "everything failed" identically.
    """
    if n <= 0:
        raise ValueError("an interval over zero observations is not an interval")
    p = k / n
    denominator = 1 + _Z_95**2 / n
    centre = (p + _Z_95**2 / (2 * n)) / denominator
    spread = (
        _Z_95 * math.sqrt(p * (1 - p) / n + _Z_95**2 / (4 * n**2))
    ) / denominator
    return max(0.0, centre - spread), min(1.0, centre + spread)


def _cases(count: Count) -> str:
    return "".join(
        f"\n      - {case.name}: {'pass' if case.passed else 'FAIL'}"
        f"{'  ' + case.evidence if case.evidence else ''}"
        for case in count.cases
    )


def render(result: Count | Sample, *, synthetic: bool, corpus_tag: str) -> str:
    """The only path from a number to a sentence. Every rule about rendering is applied here."""
    if isinstance(result, Sample):
        ordered = sorted(run.k for run in result.runs)
        head = (
            f"{corpus_tag} median {ordered[len(ordered) // 2]} of {result.runs[0].n}, "
            f"range {ordered[0]} to {ordered[-1]}, over {len(result.runs)} runs"
        )
        return head + _cases(result.runs[-1])
    if result.n == 0:
        return f"{corpus_tag} 0 of 0: the component ran and found no case to score"
    head = f"{corpus_tag} {result.k} of {result.n}"
    if synthetic:
        # No interval, because there is no population to be an interval over. A synthetic corpus
        # is a thing that was constructed, and a confidence interval on it would describe how
        # confidently the generator does what it was written to do.
        return head + " (synthetic corpus: no interval, because there is no population)" + _cases(
            result
        )
    if result.n < SMALL_N:
        return head + _cases(result)
    low, high = wilson(result.k, result.n)
    return f"{head}, 95% CI [{low * 100:.1f}%, {high * 100:.1f}%]"
