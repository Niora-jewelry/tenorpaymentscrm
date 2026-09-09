-- =============================================================================
-- Module 2 — Part 16: fix set_record_value's ambiguous column reference
--
-- FOUND BY: the smoke test in scripts/_tmp_smoke.mjs, running set_record_value
-- for real against the live database. Migration 13 typechecked and CREATEd
-- cleanly (a plpgsql body is only parsed for such ambiguity at first
-- EXECUTION, not at CREATE FUNCTION time), then failed at runtime with
-- "column reference 'updated_at' is ambiguous" — the function's own
-- `returns table (..., updated_at timestamptz, ...)` OUT parameter creates a
-- plpgsql variable named `updated_at`, which collides with the bare
-- (unqualified) `updated_at` column reference in the UPDATE's WHERE clause.
-- The RETURNING clause was already qualified (`records.updated_at`); the
-- WHERE clause was not. `create or replace` — same signature, only the one
-- ambiguous reference changes.
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
     set values = jsonb_set(values, array[p_field_key], p_new_value, true),
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
