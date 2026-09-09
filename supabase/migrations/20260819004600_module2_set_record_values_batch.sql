-- =============================================================================
-- Module 2 — Part 46: write MANY field values in one round trip.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────
-- `set_record_value` writes exactly one field. The drawer calls it once per
-- edited field, and those calls were serialised on the client (a queue added to
-- fix a compare-and-swap race, where two concurrent writes both sent the same
-- stale token). Serialising fixed the race and created a worse problem:
-- editing five fields meant five round trips end to end.
--
-- Each one costs roughly three sequential network waves against a remote
-- Supabase — the proxy's session check, `authorize()`'s own user validation,
-- then the RPC — which is 1.5-2s per field from the developer's machine.
-- Filling in five fields took over ten seconds, with a "Saving 5 changes…"
-- badge sitting on screen for all of it. That is not usable in a CRM, where
-- filling in a form IS the job.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
-- One statement for the whole batch. `p_changes` is a JSON object of
-- `field_key -> new value`, applied with a single compare-and-swap and a single
-- `updated_at` bump, and one `record_activity` row per field.
--
-- This is strictly better than the serialised loop on every axis that matters:
--
--   * ONE round trip regardless of how many fields changed.
--   * ONE compare-and-swap, so the race the client queue existed to prevent
--     cannot occur WITHIN a batch at all — there is no second token to go
--     stale. The queue stays for the gap between batches.
--   * ATOMIC. Five fields either all land or none do. The old loop could
--     apply three and then lose the CAS on the fourth, leaving the record
--     half-written with no single place that knew it.
--
-- ── THE ACTIVITY LOG IS STILL PER FIELD ──────────────────────────────────
-- CLAUDE.md rule 5: a value change and its history are one transaction. That is
-- preserved and in fact strengthened — the rows are written in the same
-- statement as the update rather than merely the same function call. One row
-- per field, each with its own `from_value`/`to_value`, so the history reads
-- exactly as it did when fields were saved one at a time. A batched write must
-- not become a batched history entry; nobody reviewing an audit trail wants
-- "5 fields changed".
--
-- ── NULL MEANS CLEAR, AS IT DOES EVERYWHERE ELSE ─────────────────────────
-- A JSON null in `p_changes` clears the field, matching migration 45: the key
-- is removed rather than set to `'null'::jsonb`. `jsonb_strip_nulls` is NOT
-- used — it would recurse into nested objects and silently strip nulls out of
-- an address or a repeat-group instance. The keys to remove are computed
-- explicitly at the top level only.
--
-- `security definer` with a pinned `search_path` per CLAUDE.md §8, and the same
-- `record_visible` gate `set_record_value` opens with. The per-FIELD permission
-- check stays in the data layer above (`setValues` in `lib/records/records.ts`),
-- exactly where the single-field path keeps it — this function is the write, not
-- the gate.
-- =============================================================================

create or replace function set_record_values(
  p_record_id           uuid,
  p_changes             jsonb,   -- { "field_key": <new value>, ... }  null = clear
  p_expected_updated_at timestamptz,
  p_summaries           jsonb    -- { "field_key": "Label changed", ... }
)
returns table (
  ok            boolean,
  updated_at    timestamptz,
  current_values jsonb,
  changed_by     uuid,
  changed_at     timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old      jsonb;
  v_new_at   timestamptz;
  v_clear    text[];
  v_set      jsonb;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'no changes supplied';
  end if;

  select r.values into v_old from records r where r.id = p_record_id;

  -- Top-level keys only, deliberately: a null nested INSIDE an address or a
  -- repeat-group instance is a real value and must survive.
  select coalesce(array_agg(k), '{}')
    into v_clear
    from jsonb_object_keys(p_changes) k
   where p_changes -> k = 'null'::jsonb;

  select coalesce(jsonb_object_agg(k, p_changes -> k), '{}'::jsonb)
    into v_set
    from jsonb_object_keys(p_changes) k
   where p_changes -> k <> 'null'::jsonb;

  update records
     set values     = (values || v_set) - v_clear,
         updated_at = now()
   where id = p_record_id
     and records.updated_at = p_expected_updated_at
     and deleted_at is null
  returning records.updated_at into v_new_at;

  if v_new_at is not null then
    -- One history row per field, in the same statement as the write above.
    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
    select p_record_id,
           auth.uid(),
           'field',
           k,
           coalesce(p_summaries ->> k, k || ' changed'),
           v_old -> k #>> '{}',
           case when p_changes -> k = 'null'::jsonb then null else p_changes -> k #>> '{}' end
      from jsonb_object_keys(p_changes) k;

    return query select true, v_new_at, null::jsonb, null::uuid, null::timestamptz;
    return;
  end if;

  -- CAS lost. Hand back only the fields this batch tried to write, so the
  -- caller can show the user what each contested cell holds now — the same
  -- "the loser is told, both values shown" the single-field path gives (§13.4),
  -- widened to the whole batch.
  return query
    select
      false,
      r.updated_at,
      (select coalesce(jsonb_object_agg(k, r.values -> k), '{}'::jsonb)
         from jsonb_object_keys(p_changes) k),
      (select a.actor_id from record_activity a
        where a.record_id = p_record_id and a.kind = 'field'
        order by a.at desc limit 1),
      (select a.at from record_activity a
        where a.record_id = p_record_id and a.kind = 'field'
        order by a.at desc limit 1)
    from records r
    where r.id = p_record_id;
end;
$$;

revoke execute on function set_record_values(uuid, jsonb, timestamptz, jsonb) from public;
grant execute on function set_record_values(uuid, jsonb, timestamptz, jsonb) to authenticated;

comment on function set_record_values(uuid, jsonb, timestamptz, jsonb) is
  'Writes many field values in ONE round trip under a single compare-and-swap, '
  'with one record_activity row per field. Replaces N serialised calls to '
  'set_record_value() from the drawer. A JSON null clears a field.';
