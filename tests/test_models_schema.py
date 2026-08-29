"""The reader half of structured output: what counts as the answer, and what counts as valid.

Two verified defects are pinned here.

**The extractor used to return the model's scratch work.** It scanned for the first balanced
object in ``message.content``. Runtime measurement recorded Nemotron spending roughly 200 reasoning
tokens
inline in ``content`` on every call, with no way to switch it off, and scratch work about a JSON
schema routinely contains a draft object. The archived probe returned the draft. It was
schema-valid, so every downstream check passed it, and a placeholder string was persisted as an
assertion about a photograph.

**Nothing validated the reply against the schema the request sent.** ``response_format
{json_schema, strict}`` is a request for enforcement, not evidence of it, and the neighbouring
``guided_json`` parameter was measured being accepted and silently ignored on this same
platform.

Every test below is written so it fails against the implementations those defects describe. The
decoy tests carry a genuine second object inside the reasoning text: a preamble with no braces in
it would exercise nothing, which is exactly the hole the review found in the previous version of
these tests.
"""

from __future__ import annotations

import pytest
from orimera.models.errors import (
    AmbiguousStructuredOutputError,
    SchemaViolationError,
    StructuredOutputError,
)
from orimera.models.schema import (
    extract_json_object,
    json_object_candidates,
    response_format_for,
    response_format_for_schema,
    strict_json_schema,
    validate_against_schema,
)
from pydantic import BaseModel

#: The probe body, as recorded. The draft object comes first and is schema-valid.
NEMOTRON_SCRATCH_WORK = (
    "The user wants a description of the photograph as JSON. Let me recall the schema. "
    'A minimal example would be {"scene_description": "PLACEHOLDER FROM MY SCRATCH WORK", '
    '"objects": []}. But actually the photo shows a waterfall, so my real answer is: '
    '{"scene_description": "A waterfall in a forest.", "objects": []}'
)


class Observation(BaseModel):
    scene_description: str
    objects: list[str]


# -- defect 2: which object is the answer ------------------------------------------------------


def test_a_decoy_object_in_the_scratch_work_is_refused_rather_than_returned():
    """The verified failure. Taking the first object returns PLACEHOLDER and persists it."""
    with pytest.raises(AmbiguousStructuredOutputError) as exc:
        extract_json_object(NEMOTRON_SCRATCH_WORK)

    # The refusal is not allowed to be a coincidence: both objects must have been seen, and
    # neither may have been chosen.
    assert len(exc.value.candidates) == 2
    assert exc.value.candidates[0]["scene_description"] == "PLACEHOLDER FROM MY SCRATCH WORK"
    assert exc.value.candidates[1]["scene_description"] == "A waterfall in a forest."


def test_the_last_object_is_not_treated_as_the_answer_either():
    """"Take the last one" would have got the probe right. It is still a guess.

    Nothing stops a reasoning model writing its conclusion and then second-guessing it in
    prose, and here the trailing object is the draft. A heuristic that reads position as
    provenance gets this one wrong in the opposite direction.
    """
    body = (
        '{"scene_description": "A waterfall in a forest.", "objects": ["waterfall"]}\n'
        "Hold on, let me double check the shape against the schema. Something like "
        '{"scene_description": "EXAMPLE ONLY", "objects": []} is what the schema wants.'
    )
    with pytest.raises(AmbiguousStructuredOutputError) as exc:
        extract_json_object(body)

    assert [candidate["scene_description"] for candidate in exc.value.candidates] == [
        "A waterfall in a forest.",
        "EXAMPLE ONLY",
    ]


def test_a_refusal_is_a_structured_output_failure_so_existing_callers_still_catch_it():
    with pytest.raises(StructuredOutputError):
        extract_json_object(NEMOTRON_SCRATCH_WORK)


def test_delimited_scratch_work_is_stripped_upstream_so_a_decoy_inside_it_is_harmless():
    """The refusal must not be over-broad.

    When the reasoning carries a tag there is a reliable boundary, ``orimera.models.reasoning``
    removes everything inside it, and only the answer reaches the extractor. A draft object in
    a delimited segment is therefore not ambiguity and must not be refused.
    """
    from orimera.models.reasoning import split_reasoning

    body = (
        "<think>An example would be "
        '{"scene_description": "PLACEHOLDER FROM MY SCRATCH WORK", "objects": []}'
        "</think>"
        '{"scene_description": "A waterfall in a forest.", "objects": ["waterfall"]}'
    )
    answer = split_reasoning(body).answer
    assert extract_json_object(answer)["scene_description"] == "A waterfall in a forest."


def test_repeating_the_same_object_is_not_ambiguous():
    """Two readings that yield the same value cannot disagree, so there is nothing to refuse."""
    obj = '{"scene_description": "A waterfall in a forest.", "objects": ["waterfall"]}'
    body = f"I will answer {obj} and to be clear the answer is {obj}"
    assert extract_json_object(body)["scene_description"] == "A waterfall in a forest."


def test_one_object_after_untagged_reasoning_is_still_extracted():
    body = (
        "Let me count the shapes. There is one bar and no waterfall. I will answer now.\n"
        '{"scene_description": "One bar.", "objects": ["bar"]}'
    )
    assert extract_json_object(body)["objects"] == ["bar"]


def test_objects_nested_inside_the_answer_are_part_of_it_and_not_rivals_to_it():
    body = '{"scene_description": "x", "objects": [], "box": {"x": 0, "y": 1}}'
    assert extract_json_object(body)["box"] == {"x": 0, "y": 1}


def test_braces_in_transcribed_signage_do_not_become_a_second_candidate():
    """Transcribed signage will eventually contain a brace. It is text, not an object."""
    body = (
        "The sign reads {OPEN} which is not JSON.\n"
        '{"scene_description": "A sign reading {OPEN}.", "objects": ["sign"]}'
    )
    assert extract_json_object(body)["objects"] == ["sign"]
    assert json_object_candidates(body) == [
        {"scene_description": "A sign reading {OPEN}.", "objects": ["sign"]}
    ]


def test_prose_with_no_object_is_a_failure_and_not_a_refusal():
    """The two failures are different and must stay different in the type as well as the text."""
    with pytest.raises(StructuredOutputError) as exc:
        extract_json_object("I found two shapes in the photograph.")
    assert not isinstance(exc.value, AmbiguousStructuredOutputError)


# -- defect 3: validating against the schema that was sent -------------------------------------


def test_an_unrelated_object_is_refused_against_the_schema_that_was_sent():
    schema = strict_json_schema(Observation)
    with pytest.raises(SchemaViolationError) as exc:
        validate_against_schema({"totally": "unrelated"}, schema, name="Observation")
    assert exc.value.errors


def test_additional_properties_are_refused_because_the_sent_schema_forbids_them():
    """Pydantic ignores extra keys by default. The schema the endpoint was sent does not."""
    schema = strict_json_schema(Observation)
    assert schema["additionalProperties"] is False
    payload = {"scene_description": "x", "objects": [], "smuggled": "in"}
    assert Observation.model_validate(payload).scene_description == "x"
    with pytest.raises(SchemaViolationError):
        validate_against_schema(payload, schema, name="Observation")


def test_a_wrong_type_is_refused():
    schema = strict_json_schema(Observation)
    with pytest.raises(SchemaViolationError):
        validate_against_schema(
            {"scene_description": "x", "objects": "not a list"}, schema, name="Observation"
        )


def test_a_conforming_payload_passes_through_unchanged():
    schema = strict_json_schema(Observation)
    payload = {"scene_description": "x", "objects": ["a"]}
    assert validate_against_schema(payload, schema) == payload


def test_a_hand_written_schema_that_is_not_legal_json_schema_is_refused_before_it_is_sent():
    """The schema is now also the validator, so a malformed one is a validator that accepts all."""
    with pytest.raises(StructuredOutputError):
        response_format_for_schema({"type": "obeject", "properties": {}}, "broken")


def test_a_top_level_array_is_refused_rather_than_reached_into():
    """The reply parsed cleanly and was the wrong type. There is nothing in it to extract.

    The scanner exists for a body that is an object surrounded by prose or a fence, and it finds
    the object inside ``[{...}]`` for the same reason. What comes out is schema-valid, so every
    later check passes it, and nothing anywhere refused a reply that did not match the schema
    that was sent.

    Reaching inside the array would be the same guess the scanner was rewritten to stop making:
    nothing in the body says the first element is the answer.
    """
    with pytest.raises(SchemaViolationError, match="array"):
        extract_json_object('[{"scene_description": "A waterfall in a forest."}]')


def test_a_top_level_scalar_is_refused_as_the_wrong_type_and_not_as_unparseable():
    """A quoted string is valid JSON, so "contains no JSON object" points at the wrong bug."""
    with pytest.raises(SchemaViolationError, match="scalar"):
        extract_json_object('"a waterfall"')


def test_an_object_that_contains_an_array_is_untouched():
    """The other side of the rule. The array has to be at the top level for this to fire.

    A body that is one JSON object is exactly what was asked for, whatever it holds inside, and
    rule 2 of this module still governs what is nested within an answer.
    """
    body = '{"scene_description": "x", "objects": [{"label": "cube"}]}'
    assert extract_json_object(body)["objects"] == [{"label": "cube"}]


def test_an_object_after_prose_is_still_extracted_when_the_body_holds_an_array_too():
    """The check must key on "the whole body is one JSON document", not on "an array appears".

    Prose in front of an object means the body does not parse as JSON at all, so the new refusal
    cannot fire and the scanner runs exactly as before. A rule that looked for a bracket instead
    would refuse this and break the case the scanner exists for.
    """
    body = 'I looked at the [image] and found: {"scene_description": "A waterfall."}'
    assert extract_json_object(body)["scene_description"] == "A waterfall."


def test_a_schema_that_constrains_nothing_is_refused_before_it_is_sent():
    """Legal JSON Schema is not the same as JSON Schema that checks anything.

    Draft 2020-12 treats an unrecognised keyword as annotation and ignores it, so
    ``propertys`` passes ``check_schema`` and then validates every object in existence.
    ``{"answer": 1}`` was accepted against this schema, and the schema is also what the reply is
    validated against locally, so a vacuous one means neither the endpoint nor this module
    enforces anything while both report success.

    That is the ``guided_json`` silent no-op one layer up, inside the module written to prevent
    it, which is why the check asks whether the schema constrains rather than whether it is
    spelled like a keyword.
    """
    with pytest.raises(StructuredOutputError, match="constrains nothing"):
        response_format_for_schema(
            {"type": "object", "propertys": {"answer": {"type": "string"}}}, "typod_v1"
        )


def test_an_object_with_no_properties_is_refused():
    """Spelled perfectly, legal, and it accepts every object there is."""
    with pytest.raises(StructuredOutputError, match="declares no properties"):
        response_format_for_schema({"type": "object"}, "open_v1")


def test_a_vacuous_object_nested_inside_a_sound_one_is_refused():
    """The outer object constrains, so a check that stopped at the root would pass this."""
    with pytest.raises(StructuredOutputError, match=r"properties\.detail"):
        response_format_for_schema(
            {
                "type": "object",
                "properties": {"detail": {"type": "object", "propertys": {}}},
                "required": ["detail"],
                "additionalProperties": False,
            },
            "nested_v1",
        )


def test_the_schema_the_product_actually_sends_is_still_accepted():
    """The other side of the rule, on the one hand-written schema in the system.

    ``OBSERVATION_SCHEMA`` carries nullable objects declared as ``{"type": ["object", "null"]}``,
    which is how an absent box and an absent place proposal are expressed. A rule that asked for
    ``type == "object"`` rather than ``"object" in type`` would refuse the vision path outright,
    so this is here to make that mistake fail loudly rather than at the next corpus pass.
    """
    from orimera.ingest.vision import OBSERVATION_SCHEMA, OBSERVATION_SCHEMA_NAME

    fmt = response_format_for_schema(OBSERVATION_SCHEMA, OBSERVATION_SCHEMA_NAME)
    assert fmt["json_schema"]["schema"] is OBSERVATION_SCHEMA


def test_the_response_format_carries_the_schema_the_validator_will_use():
    fmt = response_format_for(Observation)
    assert fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["schema"] == strict_json_schema(Observation)
