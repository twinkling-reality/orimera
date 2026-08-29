-- 0014_a_value_schema_is_enforced.sql
-- R17. `predicate.value_schema` held a JSON Schema and nothing checked an object against it.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- The column has held a JSON Schema since 0001 and nothing validated `assertion.object_value`
-- against it, so a predicate declaring `{"type":"string"}` accepted an object. The harm is a
-- downstream reader crashing on `int(row["rung"])`; it is a data-integrity defect and NOT an
-- invariant breach like R1 was, because every writer today goes through `AssertionWriter` and R5
-- guarantees a model reply was schema-checked before it became an `object_value`. What this
-- closes is the writer nobody has written yet.
--
-- ---------------------------------------------------------------------------------------------
-- TWO THINGS THIS DELIBERATELY IS NOT.
--
-- **It is not `pg_jsonschema`.** That extension is present in Supabase and in self-hosted
-- PostgreSQL and absent from RDS, Cloud SQL and Azure. Requiring it would narrow the deployment
-- target, and the deployment target is D-9, still open, and a human's decision. Narrowing it by
-- typing an extension name into a migration is deciding it by accident.
--
-- **It is not a validator that checks the top-level `type` and is named as though it checks the
-- schema.** That is R1, R4 and R16's shape a fourth time: a property stated where enforcement
-- would go, held up by less than it appears to be. A function called
-- `object_value_matches_its_schema` that only ever compared one keyword would be worse than
-- nothing, because the next reader would stop looking.
--
-- WHAT IT IS. Every keyword the vocabulary actually uses, implemented completely, plus a refusal
-- at seed time of any keyword this cannot enforce. Coverage is then total over a vocabulary that
-- is total by refusal. The day somebody needs `pattern` or `anyOf`, the migration that adds it
-- fails and names the keyword, and they decide deliberately: extend this, or take
-- `pg_jsonschema` and accept what it does to D-9.
--
-- SEVEN KEYWORDS, NOT FIVE, AND THE DIFFERENCE WAS MEASURED. A scan of `jsonb_object_keys` over
-- `predicate.value_schema` reports five: `format`, `maxLength`, `properties`, `required`, `type`.
-- That scan reads the TOP LEVEL only. `reconstruction_rung_is` nests `maximum` and `minimum`
-- inside `properties`, so a validator built to the five, with a seed-time refusal built to the
-- same five, would have refused a row 0005 already seeded. The refusal below walks the schema to
-- every depth for exactly that reason.
--
-- `format` gets the same treatment one level down: `date-time` is the only value in use and the
-- only one implemented, and any other format value is refused by name rather than ignored. An
-- unrecognised `format` that validates everything is the failure mode this file exists to avoid.
-- ---------------------------------------------------------------------------------------------
--
-- WHAT IS NOT VALIDATED, said rather than left to be discovered. A SQL NULL `object_value` is
-- skipped. It means the claim carries no object value, which is a different fact from carrying a
-- wrong one: `person_present` says somebody is in this region and its object is genuinely
-- nothing, and every `object_ref` assertion carries its object in the other column. Requiring a
-- value wherever a schema is not `{"type":"null"}` would be a second rule, it would refuse
-- writes that are correct today, and it is not the rule this column states.

begin;

select pg_advisory_xact_lock(119622309);

-- --------------------------------------------------------------------------------------------
-- 1. What this validator can enforce, and what it refuses to pretend about.
-- --------------------------------------------------------------------------------------------

-- Returns NULL when every keyword at every depth is one this file implements, and otherwise the
-- first one that is not, so the failure names the thing to decide about.
--
-- IMMUTABLE: it reads its argument and nothing else, which is what lets the CHECK constraint
-- below use it. A VOLATILE function in a CHECK is accepted by PostgreSQL and is a trap at dump
-- and restore, where the constraint is revalidated against whatever the function means then.
create or replace function jsonschema_unsupported_keyword(p_schema jsonb) returns text
language plpgsql immutable as $fn$
declare
  v_keyword text;
  v_nested  text;
  v_child   jsonb;
begin
  if p_schema is null or jsonb_typeof(p_schema) <> 'object' then
    return 'a value_schema must be a JSON object';
  end if;
  foreach v_keyword in array (select array_agg(k) from jsonb_object_keys(p_schema) k) loop
    if v_keyword not in
       ('type', 'format', 'maxLength', 'required', 'properties', 'maximum', 'minimum') then
      return v_keyword;
    end if;
  end loop;

  -- `type` as an array of names is legal JSON Schema and is not implemented, so it is refused
  -- here rather than silently ignored by a validator that reads `#>> '{}'` and gets nothing.
  if p_schema ? 'type' and jsonb_typeof(p_schema -> 'type') <> 'string' then
    return 'type given as ' || jsonb_typeof(p_schema -> 'type') || ' rather than a single name';
  end if;
  if p_schema ? 'type'
     and (p_schema ->> 'type') not in
         ('string', 'number', 'integer', 'boolean', 'object', 'array', 'null') then
    return 'type: ' || (p_schema ->> 'type');
  end if;
  -- One format, and the one the vocabulary uses. An unrecognised format that validates
  -- everything is a rule that reads as present and is not.
  if p_schema ? 'format' and (p_schema ->> 'format') <> 'date-time' then
    return 'format: ' || (p_schema ->> 'format');
  end if;
  if p_schema ? 'required' and jsonb_typeof(p_schema -> 'required') <> 'array' then
    return 'required given as ' || jsonb_typeof(p_schema -> 'required');
  end if;

  -- To every depth. The top-level scan is what missed `maximum` and `minimum`.
  if p_schema ? 'properties' then
    if jsonb_typeof(p_schema -> 'properties') <> 'object' then
      return 'properties given as ' || jsonb_typeof(p_schema -> 'properties');
    end if;
    for v_child in select value from jsonb_each(p_schema -> 'properties') loop
      v_nested := jsonschema_unsupported_keyword(v_child);
      if v_nested is not null then
        return v_nested;
      end if;
    end loop;
  end if;
  return null;
end $fn$;

comment on function jsonschema_unsupported_keyword(jsonb) is
  'NULL when a value_schema uses only keywords migration 0014 implements, at every depth, and '
  'otherwise the first keyword or value it does not. This is what makes coverage total: the '
  'vocabulary is total by refusal.';

-- --------------------------------------------------------------------------------------------
-- 2. The validator itself. Every keyword above, completely.
-- --------------------------------------------------------------------------------------------

-- Returns NULL when the value satisfies the schema, and otherwise a sentence naming the path and
-- the rule. A sentence rather than a boolean because this reaches a person as an error message,
-- and "the object did not match its schema" is not something anybody can act on.
create or replace function jsonschema_violation(
  p_schema jsonb, p_value jsonb, p_path text default 'object_value'
) returns text
language plpgsql immutable as $fn$
declare
  v_type     text;
  v_actual   text;
  v_key      text;
  v_nested   text;
begin
  if p_schema is null or jsonb_typeof(p_schema) <> 'object' then
    return null;
  end if;
  v_actual := jsonb_typeof(p_value);

  if p_schema ? 'type' then
    v_type := p_schema ->> 'type';
    if v_type = 'integer' then
      -- JSON Schema's integer is a number with no fractional part, not a distinct JSON type.
      if v_actual <> 'number' or (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric)
      then
        return p_path || ': expected an integer, got ' || coalesce(v_actual, 'nothing');
      end if;
    elsif v_actual is distinct from v_type then
      return p_path || ': expected ' || v_type || ', got ' || coalesce(v_actual, 'nothing');
    end if;
  end if;

  if p_schema ? 'maxLength' and v_actual = 'string'
     and char_length(p_value #>> '{}') > (p_schema ->> 'maxLength')::int then
    return p_path || ': longer than ' || (p_schema ->> 'maxLength') || ' characters';
  end if;

  if p_schema ? 'format' and v_actual = 'string' then
    -- date-time, the one format in the vocabulary. Anything else was refused at seed time.
    begin
      perform (p_value #>> '{}')::timestamptz;
    exception when others then
      return p_path || ': not a date-time';
    end;
  end if;

  if p_schema ? 'maximum' and v_actual = 'number'
     and (p_value #>> '{}')::numeric > (p_schema ->> 'maximum')::numeric then
    return p_path || ': greater than ' || (p_schema ->> 'maximum');
  end if;

  if p_schema ? 'minimum' and v_actual = 'number'
     and (p_value #>> '{}')::numeric < (p_schema ->> 'minimum')::numeric then
    return p_path || ': less than ' || (p_schema ->> 'minimum');
  end if;

  if p_schema ? 'required' and v_actual = 'object' then
    for v_key in select jsonb_array_elements_text(p_schema -> 'required') loop
      if not (p_value ? v_key) then
        return p_path || ': missing required key ' || quote_literal(v_key);
      end if;
    end loop;
  end if;

  -- Recursion, and only into keys the value actually has. JSON Schema's `properties` constrains
  -- the members that are present; absence is `required`'s question and it is asked above.
  if p_schema ? 'properties' and v_actual = 'object' then
    for v_key in select jsonb_object_keys(p_schema -> 'properties') loop
      if p_value ? v_key then
        v_nested := jsonschema_violation(
          p_schema -> 'properties' -> v_key, p_value -> v_key, p_path || '.' || v_key);
        if v_nested is not null then
          return v_nested;
        end if;
      end if;
    end loop;
  end if;

  return null;
end $fn$;

comment on function jsonschema_violation(jsonb, jsonb, text) is
  'NULL when the value satisfies the schema, else a sentence naming the path and the rule. '
  'Implements exactly the keywords jsonschema_unsupported_keyword permits, which is what makes '
  'the pair honest.';

-- --------------------------------------------------------------------------------------------
-- 3. A vocabulary row this cannot enforce is refused when it is written.
-- --------------------------------------------------------------------------------------------
--
-- The trigger is what names the keyword; the constraint is the backstop for the routes a
-- BEFORE trigger cannot see, and for a restore, where the constraint is revalidated and the
-- trigger is not. The same pairing 0009 uses for the functional index, and for the same reason.

create or replace function tg_predicate_schema_is_enforceable() returns trigger
language plpgsql as $fn$
declare
  v_unsupported text;
begin
  v_unsupported := jsonschema_unsupported_keyword(new.value_schema);
  if v_unsupported is not null then
    raise exception
      'predicate %: value_schema uses % , which the validator in migration 0014 does not enforce',
      new.key, v_unsupported
      using errcode = 'feature_not_supported',
            hint = 'Extend jsonschema_violation and jsonschema_unsupported_keyword together in '
                   'a new migration, or take pg_jsonschema and accept that it narrows the '
                   'deployment target to platforms that carry it. A value_schema this cannot '
                   'check is a rule that reads as enforced and is not.';
  end if;
  return new;
end $fn$;

create trigger tg_predicate_schema_is_enforceable
  before insert or update of value_schema on predicate
  for each row execute function tg_predicate_schema_is_enforceable();

alter table predicate add constraint value_schema_is_enforceable
  check (jsonschema_unsupported_keyword(value_schema) is null);

-- --------------------------------------------------------------------------------------------
-- 4. And the object is checked against it.
-- --------------------------------------------------------------------------------------------

create or replace function tg_assertion_object_matches_its_schema() returns trigger
language plpgsql as $fn$
declare
  v_schema    jsonb;
  v_violation text;
begin
  -- A claim with no object value carries its object elsewhere or has none. See this file's
  -- header: that is a different fact from carrying a wrong one.
  if new.object_value is null then
    return new;
  end if;
  select p.value_schema into v_schema from predicate p where p.predicate_id = new.predicate_id;
  v_violation := jsonschema_violation(v_schema, new.object_value);
  if v_violation is not null then
    raise exception 'assertion object_value does not match the predicate schema: %', v_violation
      using errcode = 'integrity_constraint_violation',
            hint = 'predicate.value_schema states what this predicate''s object is. A row that '
                   'does not match it is a reader crashing later on a value it was promised.';
  end if;
  return new;
end $fn$;

-- BEFORE INSERT OR UPDATE OF object_value. The update branch is not decoration: 0002 forbids
-- rewriting object_value in place, and this fires ahead of that so a route that tried would be
-- refused for the reason it is actually wrong about rather than only for being an update.
create trigger tg_assertion_object_matches_its_schema
  before insert or update of object_value on assertion
  for each row execute function tg_assertion_object_matches_its_schema();

commit;
