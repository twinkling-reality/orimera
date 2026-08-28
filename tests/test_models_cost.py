"""The cache, the budget guard and cost accounting.

These three are the difference between a $1 corpus pass and a $10 one, so the tests assert on
call counts and exact decimal amounts rather than on the existence of a method.
"""

from __future__ import annotations

import json
from decimal import Decimal

import pytest
from orimera.models.budget import BudgetGuard
from orimera.models.cache import (
    FileResponseCache,
    InMemoryResponseCache,
    cache_key,
    request_digest,
)
from orimera.models.client import ModelClient
from orimera.models.errors import BudgetExceededError
from orimera.models.manifest import Role
from orimera.models.transport import HttpResponse
from orimera.models.usage import CallUsage, CostLedger

from model_fakes import chat_body

MESSAGES = [{"role": "user", "content": "where was this taken"}]


def ok(body) -> HttpResponse:
    return HttpResponse(status_code=200, text=json.dumps(body))


def make_client(manifest, transport, *, cache=None, budget=None):
    return ModelClient(
        api_key="test-key",
        manifest=manifest,
        transport=transport,
        cache=cache,
        budget=budget or BudgetGuard(ceiling_usd=Decimal("5.00"), max_calls=1000),
    )


# -- cache ---------------------------------------------------------------------------------


def test_cache_hit_avoids_a_second_call(manifest, transport):
    """Invariant 6: re-running ingest must not re-bill."""
    cache = InMemoryResponseCache()
    transport.default = ok(chat_body("Reykjavik"))
    client = make_client(manifest, transport, cache=cache)

    first = client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    second = client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")

    assert transport.call_count == 1, "the second call went to the network"
    assert first.answer == second.answer == "Reykjavik"
    assert first.cache_hit is False
    assert second.cache_hit is True
    assert second.usage.usd == Decimal(0)
    assert client.ledger.total_usd == first.usage.usd


def test_a_new_prompt_version_misses_the_cache(manifest, transport):
    """Editing a prompt and silently getting the old prompt's answers wastes an afternoon."""
    cache = InMemoryResponseCache()
    transport.default = ok(chat_body("x"))
    client = make_client(manifest, transport, cache=cache)

    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v2")
    assert transport.call_count == 2


def test_a_new_pipeline_version_misses_the_cache(manifest, transport):
    """Replacing a model identifier must invalidate every answer the old model produced."""
    key_a = cache_key({"messages": []}, pipeline_version=1, role=Role.VISION, prompt_version="v1")
    key_b = cache_key({"messages": []}, pipeline_version=2, role=Role.VISION, prompt_version="v1")
    assert key_a.digest != key_b.digest


def test_a_different_role_misses_the_cache():
    payload = {"messages": [{"role": "user", "content": "same text"}]}
    a = cache_key(payload, pipeline_version=1, role=Role.VISION, prompt_version="v1")
    b = cache_key(payload, pipeline_version=1, role=Role.REASONING_CHEAP, prompt_version="v1")
    assert a.digest != b.digest


def test_the_model_id_is_not_in_the_key(manifest):
    """A fallback swap during a deprecation must still hit the cache.

    Otherwise a withdrawal turns into a full re-bill on top of a quality regression.
    """
    base = {"messages": [{"role": "user", "content": "hello"}], "max_tokens": 2048}
    primary = manifest[Role.REASONING_CHEAP].primary.model_id
    fallback = manifest[Role.REASONING_CHEAP].fallback.model_id
    assert request_digest({**base, "model": primary}) == request_digest({**base, "model": fallback})


def test_cached_entry_records_which_model_served_it(manifest, transport):
    cache = InMemoryResponseCache()
    transport.default = ok(chat_body("x"))
    client = make_client(manifest, transport, cache=cache)
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    entry = next(iter(cache.entries.values()))
    assert entry["model_id"] == manifest[Role.REASONING_CHEAP].primary.model_id
    assert entry["pipeline_version"] == manifest.pipeline_version


def test_a_changed_message_misses_the_cache(manifest, transport):
    cache = InMemoryResponseCache()
    transport.default = ok(chat_body("x"))
    client = make_client(manifest, transport, cache=cache)
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    client.chat(
        Role.REASONING_CHEAP,
        [{"role": "user", "content": "a different question"}],
        prompt_version="v1",
    )
    assert transport.call_count == 2


def test_file_cache_survives_a_new_client(manifest, transport, tmp_path):
    cache = FileResponseCache(tmp_path / "responses")
    transport.default = ok(chat_body("cached to disk"))
    make_client(manifest, transport, cache=cache).chat(
        Role.REASONING_CHEAP, MESSAGES, prompt_version="v1"
    )
    assert transport.call_count == 1

    fresh = make_client(manifest, transport, cache=FileResponseCache(tmp_path / "responses"))
    result = fresh.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    assert transport.call_count == 1
    assert result.answer == "cached to disk"
    assert result.cache_hit is True


def test_a_corrupt_cache_entry_is_a_miss_not_a_crash(manifest, transport, tmp_path):
    cache = FileResponseCache(tmp_path / "responses")
    transport.default = ok(chat_body("x"))
    make_client(manifest, transport, cache=cache).chat(
        Role.REASONING_CHEAP, MESSAGES, prompt_version="v1"
    )
    for path in (tmp_path / "responses").rglob("*.json"):
        path.write_text("{ this is not json", encoding="utf-8")

    result = make_client(manifest, transport, cache=cache).chat(
        Role.REASONING_CHEAP, MESSAGES, prompt_version="v1"
    )
    assert transport.call_count == 2
    assert result.answer == "x"


def test_use_cache_false_always_calls(manifest, transport):
    cache = InMemoryResponseCache()
    transport.default = ok(chat_body("x"))
    client = make_client(manifest, transport, cache=cache)
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1", use_cache=False)
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1", use_cache=False)
    assert transport.call_count == 2


# -- budget guard ----------------------------------------------------------------------------


def test_budget_guard_refuses_before_sending_anything(manifest, transport):
    """Prepaid platform, so this cannot prevent an overrun. It catches the loop that causes one."""
    guard = BudgetGuard(ceiling_usd=Decimal("0.00001"), max_calls=1000)
    client = make_client(manifest, transport, budget=guard)
    transport.default = ok(chat_body("x"))

    with pytest.raises(BudgetExceededError, match="No request was sent"):
        client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    assert transport.call_count == 0


def test_budget_guard_stops_a_runaway_loop_partway(manifest, transport):
    """A loop runs until the ceiling and then refuses, rather than running to the balance."""
    # Each call is 100 in + 200 out at 0.06/0.24 per M = $0.00004800. Reservation is pessimistic
    # (max_tokens at the output price), so the ceiling bites well before a hundred calls.
    guard = BudgetGuard(ceiling_usd=Decimal("0.01"), max_calls=5000)
    client = make_client(manifest, transport, budget=guard)
    transport.default = ok(chat_body("x"))

    calls = 0
    with pytest.raises(BudgetExceededError):
        for i in range(5000):
            client.chat(
                Role.REASONING_CHEAP,
                [{"role": "user", "content": f"q{i}"}],
                prompt_version="v1",
            )
            calls += 1
    assert 0 < calls < 5000
    assert guard.spent_usd <= guard.ceiling_usd


def test_call_ceiling_catches_a_cheap_loop(manifest, transport):
    """Ten thousand calls at $0.00005 is fifty cents, so a dollar ceiling would never fire."""
    guard = BudgetGuard(ceiling_usd=Decimal("1000"), max_calls=3)
    client = make_client(manifest, transport, budget=guard)
    transport.default = ok(chat_body("x"))

    for i in range(3):
        client.chat(
            Role.REASONING_CHEAP, [{"role": "user", "content": f"q{i}"}], prompt_version="v1"
        )
    with pytest.raises(BudgetExceededError, match="runaway loop"):
        client.chat(
            Role.REASONING_CHEAP,
            [{"role": "user", "content": "one too many"}],
            prompt_version="v1",
        )


def test_a_cache_hit_does_not_consume_the_call_ceiling(manifest, transport):
    """Cached answers cost nothing, so they must not count against a budget for spending."""
    guard = BudgetGuard(ceiling_usd=Decimal("1000"), max_calls=1)
    cache = InMemoryResponseCache()
    client = make_client(manifest, transport, cache=cache, budget=guard)
    transport.default = ok(chat_body("x"))

    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    for _ in range(5):
        result = client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
        assert result.cache_hit is True
    assert transport.call_count == 1


def test_the_reservation_is_pessimistic(manifest):
    """Reserving less than a call can cost would let the last call cross the ceiling."""
    guard = BudgetGuard(ceiling_usd=Decimal("5"), max_calls=100)
    spec = manifest[Role.REASONING_CHEAP].primary
    reserved = guard.estimate_usd(spec, prompt_chars=3000, max_tokens=2048)
    actual = spec.cost_usd(prompt_tokens=800, completion_tokens=300)
    assert reserved > actual


def test_budget_ceiling_reads_the_environment(monkeypatch):
    monkeypatch.setenv("ORIMERA_BUDGET_USD", "0.25")
    assert BudgetGuard().ceiling_usd == Decimal("0.25")


def test_a_nonsense_ceiling_is_rejected(monkeypatch):
    monkeypatch.setenv("ORIMERA_BUDGET_USD", "lots")
    with pytest.raises(ValueError, match="ORIMERA_BUDGET_USD"):
        BudgetGuard()


# -- cost accounting --------------------------------------------------------------------------


def test_usage_records_real_reported_tokens_including_reasoning(manifest, transport):
    transport.default = ok(
        chat_body("x", prompt_tokens=26, completion_tokens=154, reasoning_tokens=149)
    )
    client = make_client(manifest, transport)
    result = client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")

    assert result.usage.prompt_tokens == 26
    assert result.usage.completion_tokens == 154
    assert result.usage.reasoning_tokens == 149


def test_reasoning_tokens_are_not_billed_twice(manifest):
    """Reported completion_tokens already contains reasoning_tokens (measured: 154 of which 149)."""
    spec = manifest[Role.REASONING_CHEAP].primary
    usage = CallUsage.from_response(
        role=Role.REASONING_CHEAP,
        spec=spec,
        usage={
            "prompt_tokens": 26,
            "completion_tokens": 154,
            "completion_tokens_details": {"reasoning_tokens": 149},
        },
    )
    expected = (Decimal(26) * Decimal("0.06") + Decimal(154) * Decimal("0.24")) / Decimal(1_000_000)
    assert usage.usd == expected.quantize(Decimal("0.00000001"))


def test_ledger_totals_and_cost_json(manifest, transport):
    transport.default = ok(chat_body("x", prompt_tokens=1000, completion_tokens=500))
    client = make_client(manifest, transport)
    for i in range(3):
        client.chat(
            Role.REASONING_CHEAP, [{"role": "user", "content": f"q{i}"}], prompt_version="v1"
        )

    ledger = client.ledger
    assert len(ledger) == 3
    assert ledger.billed_calls == 3
    assert ledger.total_prompt_tokens == 3000
    assert ledger.total_completion_tokens == 1500

    cost = ledger.as_cost_json()
    assert cost["input_tokens"] == 3000
    assert cost["output_tokens"] == 1500
    assert isinstance(cost["usd_estimate"], str), "a float would rewrite the last digits"
    assert Decimal(cost["usd_estimate"]) == ledger.total_usd.quantize(Decimal("0.00000001"))


def test_cache_savings_are_reported_rather_than_asserted(manifest, transport):
    cache = InMemoryResponseCache()
    transport.default = ok(chat_body("x", prompt_tokens=1000, completion_tokens=500))
    client = make_client(manifest, transport, cache=cache)
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")

    ledger = client.ledger
    assert ledger.cache_hits == 1
    assert ledger.usd_avoided_by_cache > 0
    assert ledger.usd_avoided_by_cache == ledger.total_usd


def test_per_call_cost_json_matches_the_pipeline_event_shape(manifest, transport):
    transport.default = ok(chat_body("x"))
    client = make_client(manifest, transport)
    result = client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    cost = result.usage.as_cost_json()
    assert set(cost) >= {"input_tokens", "output_tokens", "usd_estimate"}
    # Serverless inference reports no GPU seconds; a zero would read as a measurement taken.
    assert "gpu_seconds" not in cost


def test_ledger_splits_spend_by_role_and_model(manifest, transport):
    transport.default = ok(chat_body("x"))
    client = make_client(manifest, transport)
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    client.chat(Role.VISION, MESSAGES, prompt_version="v1")

    by_role = client.ledger.by_role()
    assert set(by_role) == {"reasoning_cheap", "vision"}
    assert by_role["vision"] > by_role["reasoning_cheap"], "the vision model is the dearer one"
    assert set(client.ledger.by_model()) == {
        manifest[Role.REASONING_CHEAP].primary.model_id,
        manifest[Role.VISION].primary.model_id,
    }


def test_summary_is_printable(manifest, transport):
    transport.default = ok(chat_body("x"))
    client = make_client(manifest, transport)
    client.chat(Role.REASONING_CHEAP, MESSAGES, prompt_version="v1")
    text = client.ledger.summary()
    assert "spend:" in text and "reasoning" in text


def test_an_empty_ledger_totals_zero():
    assert CostLedger().total_usd == Decimal(0)
