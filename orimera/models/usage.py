"""Cost accounting from real reported usage, never from an estimate.

The project has committed to reporting actual spend rather than a projection, so every number
here comes out of the provider's own ``usage`` object. Three details decide whether the total is
right:

*   ``reasoning_tokens`` lives in ``usage.completion_tokens_details`` and is **already inside**
    ``completion_tokens`` (measured: 154 completion of which 149 reasoning). It is recorded
    separately because it is a floor on every call rather than a variable, which matters for
    latency budgets, but it is never added to the bill a second time.
*   ``prompt_cache_hit_tokens`` is reported and no discount for it is published. Cached prompt
    tokens are therefore billed at full input price. An estimate that is too low is worse than
    one that is too high, because it is the one that produces a surprise.
*   A cache hit costs nothing and is recorded with ``usd`` zero. The tokens it *would* have cost
    are kept in ``usd_avoided``, which is how the project can say what idempotency actually saved
    rather than asserting that it saves.

``as_cost_json`` emits the shape ``pipeline_event.cost`` expects in migration 0001, with
``usd_estimate`` as a decimal **string**. A float would rewrite the last digits on the JSON round
trip, and a cost nobody can reconcile against an invoice is not accounting.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Final

from orimera.models.manifest import ModelSpec, Role

__all__ = ["USD_QUANTUM", "CallUsage", "CostLedger"]

#: Eight decimal places. A single cheap call costs about $0.00005, so cents would round the
#: entire corpus pass to zero.
USD_QUANTUM: Final = Decimal("0.00000001")


def _as_int(value: Any) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


@dataclass(frozen=True, slots=True)
class CallUsage:
    """What one call actually consumed."""

    role: Role
    model_id: str
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int
    cached_prompt_tokens: int
    usd: Decimal
    usd_avoided: Decimal = Decimal(0)
    cache_hit: bool = False
    used_fallback: bool = False
    latency_s: float = 0.0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @classmethod
    def from_response(
        cls,
        *,
        role: Role,
        spec: ModelSpec,
        usage: Mapping[str, Any] | None,
        cache_hit: bool = False,
        used_fallback: bool = False,
        latency_s: float = 0.0,
    ) -> CallUsage:
        """Build from a provider ``usage`` object. A missing object yields zeros, not a guess."""
        usage = usage or {}
        details = usage.get("completion_tokens_details") or {}
        prompt_tokens = _as_int(usage.get("prompt_tokens"))
        completion_tokens = _as_int(usage.get("completion_tokens"))
        cost = spec.cost_usd(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens)
        cost = cost.quantize(USD_QUANTUM)
        return cls(
            role=role,
            model_id=spec.model_id,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            reasoning_tokens=_as_int(details.get("reasoning_tokens")),
            cached_prompt_tokens=_as_int(usage.get("prompt_cache_hit_tokens")),
            usd=Decimal(0) if cache_hit else cost,
            usd_avoided=cost if cache_hit else Decimal(0),
            cache_hit=cache_hit,
            used_fallback=used_fallback,
            latency_s=latency_s,
        )

    def as_cost_json(self) -> dict[str, Any]:
        """The ``pipeline_event.cost`` payload for this one call.

        ``gpu_seconds`` is absent rather than zero. Serverless inference reports none, and a zero
        would read as a measurement that was taken.
        """
        return {
            "input_tokens": self.prompt_tokens,
            "output_tokens": self.completion_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "cached_input_tokens": self.cached_prompt_tokens,
            "usd_estimate": str(self.usd),
            "cache_hit": self.cache_hit,
            "model_id": self.model_id,
            "role": str(self.role),
        }


@dataclass
class CostLedger:
    """Every call this process made, and what it cost.

    Deliberately in-process and in-memory. Durable accounting belongs in ``pipeline_event.cost``
    where it is attributable to a stage; this exists so a script, a test, or the demo can print
    what a corpus pass really cost the moment it finishes.
    """

    calls: list[CallUsage] = field(default_factory=list)

    def record(self, usage: CallUsage) -> CallUsage:
        self.calls.append(usage)
        return usage

    def __len__(self) -> int:
        return len(self.calls)

    @property
    def total_usd(self) -> Decimal:
        return sum((c.usd for c in self.calls), Decimal(0))

    @property
    def usd_avoided_by_cache(self) -> Decimal:
        return sum((c.usd_avoided for c in self.calls), Decimal(0))

    @property
    def billed_calls(self) -> int:
        return sum(1 for c in self.calls if not c.cache_hit)

    @property
    def cache_hits(self) -> int:
        return sum(1 for c in self.calls if c.cache_hit)

    @property
    def fallback_calls(self) -> int:
        return sum(1 for c in self.calls if c.used_fallback)

    @property
    def total_prompt_tokens(self) -> int:
        return sum(c.prompt_tokens for c in self.calls if not c.cache_hit)

    @property
    def total_completion_tokens(self) -> int:
        return sum(c.completion_tokens for c in self.calls if not c.cache_hit)

    @property
    def total_reasoning_tokens(self) -> int:
        return sum(c.reasoning_tokens for c in self.calls if not c.cache_hit)

    def by_role(self) -> dict[str, Decimal]:
        totals: dict[str, Decimal] = {}
        for call in self.calls:
            totals[str(call.role)] = totals.get(str(call.role), Decimal(0)) + call.usd
        return totals

    def by_model(self) -> dict[str, Decimal]:
        totals: dict[str, Decimal] = {}
        for call in self.calls:
            totals[call.model_id] = totals.get(call.model_id, Decimal(0)) + call.usd
        return totals

    def as_cost_json(self) -> dict[str, Any]:
        """Aggregate in the ``pipeline_event.cost`` shape, for a whole run."""
        return {
            "input_tokens": self.total_prompt_tokens,
            "output_tokens": self.total_completion_tokens,
            "reasoning_tokens": self.total_reasoning_tokens,
            "usd_estimate": str(self.total_usd.quantize(USD_QUANTUM)),
            "calls": len(self.calls),
            "billed_calls": self.billed_calls,
            "cache_hits": self.cache_hits,
            "usd_avoided_by_cache": str(self.usd_avoided_by_cache.quantize(USD_QUANTUM)),
        }

    def summary(self) -> str:
        """One human-readable block. Used by scripts and by the end of a corpus pass."""
        lines: Sequence[str] = [
            f"calls: {len(self.calls)} ({self.billed_calls} billed, "
            f"{self.cache_hits} cached, {self.fallback_calls} on a fallback model)",
            f"tokens: {self.total_prompt_tokens} in, {self.total_completion_tokens} out "
            f"(of which {self.total_reasoning_tokens} reasoning)",
            f"spend: ${self.total_usd.quantize(USD_QUANTUM)} "
            f"(${self.usd_avoided_by_cache.quantize(USD_QUANTUM)} avoided by cache)",
            *(
                f"  {role}: ${amount.quantize(USD_QUANTUM)}"
                for role, amount in sorted(self.by_role().items())
            ),
        ]
        return "\n".join(lines)
