-- =============================================================================
-- Module 2 — Part 45: clearing a field no longer fails with a NOT NULL error.
--
-- ── THE BUG ──────────────────────────────────────────────────────────────
-- `jsonb_set()` is STRICT: if ANY argument is NULL it returns NULL. Both
-- writers pass the new value straight into it:
--
--     set values = jsonb_set(values, array[p_field_key], p_new_value, true)
--
-- and `setValue` in `lib/records/records.ts` deliberately sends SQL NULL for an
-- empty value ("" and null both mean "cleared"). So clearing a field computed
-- `values = NULL` for the WHOLE record and hit the column's own NOT NULL
-- constraint:
--
--     23502 — null value in column "values" of relation "records"
--             violates not-null constraint
--
-- Seen live on a real record (`izzys`, three times in a row) while emptying a
-- date and a dropdown. The RPC raised, `setValue` re-threw, and the drawer
-- rolled the cell back — so clearing a field looked like a field that simply
-- refused to clear, with a "could not reach the server" message blaming the
-- network. Nothing was corrupted: the update never applied, which is the one
-- mercy in it. The record's other values were untouched throughout.
--
-- `bulk_set_values` had the identical bug on the identical line, so clearing a
-- field across a selection failed the same way — except there it failed the
-- entire chunk of up to 500 records at once.
--
-- ── THE FIX: A CLEARED FIELD LOSES ITS KEY ───────────────────────────────
-- `values - p_field_key` removes the key rather than storing `'null'::jsonb`.
-- Both would read back as empty — every reader in the app tests
-- `v == null || v === ''` — but removing it is the honest representation and
-- keeps the document from filling with dead `"field": null` entries, which
-- would otherwise be indistinguishable from a field that was never set and
-- would count against the "how many fields are filled" badge forever.
--
-- The history row still records the clear: `to_value` is `p_new_value #>> '{}'`,
-- which is NULL for a cleared field, and `from_value` keeps whatever the field
-- held. So the activity log shows the before and after exactly as it does for
-- any other change — this is a value change, not a deletion, and it stays in
-- the same transaction as the write (CLAUDE.md rule 5).
--
-- `create or replace` on both, same signatures — only the assigned expression
-- changes. Everything else in `set_record_value`, including the compare-and-swap
-- and the "tell the loser" branch, is carried over verbatim from migration 16.
-- =============================================================================

create or replace function set_record_value(
  p_record_id           uuid,
  p_field_key           text,
  p_new_value           jsonb,
  p_expected_updated_at timestamptz,
  p_summary             text
)
returns table (
  ok          boolean,
  updated_at  timestamptz,
  current_value jsonb,
  changed_by    uuid,
  changed_at    timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_value jsonb;
  v_new_at    timestamptz;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  select r.values -> p_field_key into v_old_value from records r where r.id = p_record_id;

  update records
     set values = case
                    when p_new_value is null then values - p_field_key
                    else jsonb_set(values, array[p_field_key], p_new_value, true)
                  end,
         updated_at = now()
   where id = p_record_id
     and records.updated_at = p_expected_updated_at
     and deleted_at is null
  returning records.updated_at into v_new_at;

  if v_new_at is not null then
    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
    values (p_record_id, auth.uid(), 'field', p_field_key, p_summary,
            v_old_value #>> '{}', p_new_value #>> '{}');

    return query select true, v_new_at, null::jsonb, null::uuid, null::timestamptz;
    return;
  end if;

  -- CAS lost: someone else saved first. Tell the loser who, what, and when —
  -- "Sarah changed this a moment ago" needs all three, not a bare boolean.
  return query
    select
      false,
      r.updated_at,
      r.values -> p_field_key,
      (select a.actor_id from record_activity a
        where a.record_id = p_record_id and a.field_key = p_field_key and a.kind = 'field'
        order by a.at desc limit 1),
      (select a.at from record_activity a
        where a.record_id = p_record_id and a.field_key = p_field_key and a.kind = 'field'
        order by a.at desc limit 1)
    from records r
    where r.id = p_record_id;
end;
$$;

revoke execute on function set_record_value(uuid, text, jsonb, timestamptz, text) from public;
grant execute on function set_record_value(uuid, text, jsonb, timestamptz, text) to authenticated;

-- -----------------------------------------------------------------------------
-- The same one-line fix on the bulk path.
-- -----------------------------------------------------------------------------
create or replace function bulk_set_values(
  p_record_ids uuid[],
  p_field_key  text,
  p_new_value  jsonb,
  p_summary    text
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated uuid[];
begin
  set local statement_timeout = '5s';

  with upd as (
    update records
       set values = case
                      when p_new_value is null then values - p_field_key
                      else jsonb_set(values, array[p_field_key], p_new_value, true)
                    end,
           updated_at = now()
     where id = any(p_record_ids)
       and deleted_at is null
       and can_see_record(id)
    returning id
  )
  select array_agg(id) into v_updated from upd;

  insert into record_activity (record_id, actor_id, kind, field_key, summary, to_value)
  select u, auth.uid(), 'field', p_field_key, p_summary, p_new_value #>> '{}'
    from unnest(coalesce(v_updated, '{}')) as u;

  -- Ids requested but absent here are the caller's skip list: not visible,
  -- already deleted, or raced (changed/removed between selection and this
  -- call) — SCHEMA-DECISIONS §8's "changed since your selection".
  return coalesce(v_updated, '{}');
end;
$$;

revoke execute on function bulk_set_values(uuid[], text, jsonb, text) from public;
grant execute on function bulk_set_values(uuid[], text, jsonb, text) to authenticated;
