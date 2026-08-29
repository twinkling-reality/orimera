-- 0010_entity_renamed.sql
-- The account holder corrects a name they gave, and the log can say so.
--
-- Target: PostgreSQL 18, same as 0001. Forward-only, same as 0001.
--
-- `identity_event_type` had no value for it, because the API could name an occurrence and could
-- not rename an entity. A rename recorded as `entity_created` would be a second creation of
-- something that already existed, and one recorded as nothing at all would be a change to
-- canonical state with no actor and no timestamp, which is the one thing this log exists for.
--
-- Adding an enum value inside a transaction is permitted from PostgreSQL 12 provided the value
-- is not USED in the same transaction. Nothing here uses it.

begin;

select pg_advisory_xact_lock(119622309);

alter type identity_event_type add value if not exists 'entity_renamed';

commit;
