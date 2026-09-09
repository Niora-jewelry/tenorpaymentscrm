-- =============================================================================
-- Module 2 — Part 14: bulk_set_values
--
-- SCHEMA-DECISIONS §8: chunk at 500 record ids per statement, 5s statement
-- timeout per chunk, one activity entry per row actually updated. This
-- function IS one chunk; `lib/records/records.ts` calls it once per ≤500-id
-- slice per field being bulk-edited, and aggregates the skip report across
-- calls. SECURITY DEFINER, so it re-checks can_see_record() itself per row —
-- unlike an ordinary RLS-gated statement, this function does not inherit the
-- caller's row-visibility restriction for free.
-- =============================================================================

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
       set values = jsonb_set(values, array[p_field_key], p_new_value, true),
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

revoke all on function bulk_set_values(uuid[], text, jsonb, text) from anon, authenticated;
grant execute on function bulk_set_values(uuid[], text, jsonb, text) to authenticated;
