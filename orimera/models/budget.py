"""The budget guard: a ceiling on what one process may spend before it refuses to call.

What this is honestly for. Token Factory is prepaid and the balance is $25, so spend physically
cannot exceed the balance and this guard cannot prevent a real overrun. What it catches is a
runaway loop: a retry that does not back off, a recursive agent step, a test that accidentally
points at the live endpoint. Those burn a prepaid balance in minutes, and the balance is the
whole demo. So the guard is a development safety rail, described as one, and it is not a
substitute for the platform's own limit.

Two ceilings, because the two failure modes look different:

*   ``ceiling_usd`` catches an expensive loop, for example a vision pass that never terminates.
*   ``max_calls`` catches a cheap loop. Ten thousand calls at $0.00005 is only fifty cents, so a
    dollar ceiling would never fire, but ten thousand calls is unambiguously a bug.

The reservation is deliberately pessimistic. Before a call, the true prompt-token count is
unknown, so the guard reserves the caller's ``max_tokens`` at the output price plus an estimate
of the prompt at the input price. Reserving less than the call can cost would let the very last
call cross the ceiling, which is the one thing the guard exists to prevent.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Final

from orimera.models.errors import BudgetExceededError
from orimera.models.manifest import ModelSpec, Role
from orimera.models.usage import USD_QUANTUM, CallUsage, CostLedger

__all__ = ["DEFAULT_CEILING_USD", "DEFAULT_MAX_CALLS", "BudgetGuard"]

#: A full corpus pass was measured at roughly $0.41, and twenty development iterations at about
#: $10. Five dollars is generous for one process and small against a $25 prepaid balance, so a
#: runaway is caught while normal work never notices.
DEFAULT_CEILING_USD: Final = Decimal("5.00")

#: A corpus is around 150 photographs plus a few hundred reasoning turns. Two thousand calls in
#: one process is not a workload, it is a loop.
DEFAULT_MAX_CALLS: Final = 2000

_CEILING_ENV: Final = "ORIMERA_BUDGET_USD"
_MAX_CALLS_ENV: Final = "ORIMERA_BUDGET_MAX_CALLS"

#: Characters per token, used only to size a reservation. Deliberately low, which over-estimates
#: the token count, which over-reserves. Never used for accounting: reported usage is.
_CHARS_PER_TOKEN: Final = Decimal(3)


def _env_decimal(name: str, default: Decimal) -> Decimal:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = Decimal(raw.strip())
    except InvalidOperation as exc:
        raise ValueError(f"{name}={raw!r} is not a decimal amount") from exc
    if value < 0:
        raise ValueError(f"{name}={raw!r} is negative")
    return value


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    value = int(raw.strip())
    if value < 0:
        raise ValueError(f"{name}={raw!r} is negative")
    return value


@dataclass
class BudgetGuard:
    """Refuses a call that could take cumulative spend past the ceiling.

    Holds the ledger, so ``spent`` and ``remaining`` are always the same numbers the cost report
    prints. A guard with its own private counter would eventually disagree with the report, and
    then neither number would be trustworthy.
    """

    ceiling_usd: Decimal = field(
        default_factory=lambda: _env_decimal(_CEILING_ENV, DEFAULT_CEILING_USD)
    )
    max_calls: int = field(default_factory=lambda: _env_int(_MAX_CALLS_ENV, DEFAULT_MAX_CALLS))
    ledger: CostLedger = field(default_factory=CostLedger)

    @property
    def spent_usd(self) -> Decimal:
        return self.ledger.total_usd

    @property
    def remaining_usd(self) -> Decimal:
        return self.ceiling_usd - self.spent_usd

    @property
    def billed_calls(self) -> int:
        return self.ledger.billed_calls

    def estimate_usd(
        self,
        spec: ModelSpec,
        *,
        prompt_chars: int = 0,
        max_tokens: int = 0,
        extra_prompt_tokens: int = 0,
    ) -> Decimal:
        """Worst-case cost of a call that has not happened yet.

        ``extra_prompt_tokens`` carries image cost, which characters cannot express: a 768px
        image was measured at 772 prompt tokens with almost no accompanying text.
        """
        prompt_tokens = int(Decimal(max(prompt_chars, 0)) / _CHARS_PER_TOKEN) + extra_prompt_tokens
        return spec.cost_usd(
            prompt_tokens=prompt_tokens, completion_tokens=max(max_tokens, 0)
        ).quantize(USD_QUANTUM)

    def reserve(
        self,
        spec: ModelSpec,
        *,
        role: Role,
        prompt_chars: int = 0,
        max_tokens: int = 0,
        extra_prompt_tokens: int = 0,
    ) -> Decimal:
        """Check that this call may proceed. Raises ``BudgetExceededError`` if it may not.

        Never retry a ``BudgetExceededError``. Retrying is the loop the guard is stopping.
        """
        if self.billed_calls >= self.max_calls:
            raise BudgetExceededError(
                f"call ceiling reached: {self.billed_calls} billed calls in this process, limit "
                f"{self.max_calls}. This is a runaway loop, not a workload. Raise "
                f"{_MAX_CALLS_ENV} only after establishing why.",
                spent_usd=self.spent_usd,
                ceiling_usd=self.ceiling_usd,
            )
        projected = self.estimate_usd(
            spec,
            prompt_chars=prompt_chars,
            max_tokens=max_tokens,
            extra_prompt_tokens=extra_prompt_tokens,
        )
        if self.spent_usd + projected > self.ceiling_usd:
            raise BudgetExceededError(
                f"budget ceiling would be crossed: spent ${self.spent_usd.quantize(USD_QUANTUM)}, "
                f"this {role} call could cost up to ${projected}, ceiling "
                f"${self.ceiling_usd}. No request was sent. Raise {_CEILING_ENV} deliberately if "
                "this is real work.",
                spent_usd=self.spent_usd,
                ceiling_usd=self.ceiling_usd,
            )
        return projected

    def record(self, usage: CallUsage) -> CallUsage:
        """Record what the call actually cost, replacing the reservation with the real number."""
        return self.ledger.record(usage)
