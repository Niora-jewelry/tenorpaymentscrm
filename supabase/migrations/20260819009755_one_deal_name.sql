begin;

-- ════════════════════════════════════════════════════════════════════════
-- One Deal Name, stored once
-- ════════════════════════════════════════════════════════════════════════
--
-- The client: "Deal name in drawer (tab overview) should equal item name
-- (first column in dashboard)."
--
-- They were two different pieces of storage. `records.deal_name` is a real
-- column - it carries the unique index that blocks duplicates, it titles the
-- drawer, and it fills the dashboard's frozen first column. But `deal_name`
-- is ALSO a field, so editing it in the drawer wrote `values->'deal_name'`
-- and never touched the column. Nothing kept the two equal.
--
-- Four of thirty-four records had already drifted:
--
--     column              values
--     ------------------  ------------------
--     testing residuals   testing residual
--     izzys               Brimesh
--     phase0_test         (none)
--     sdsadsda            (none)
--
-- This is worse than a cosmetic mismatch. The name is the duplicate-blocking
-- key, and only the column is indexed - so a record renamed in the drawer
-- could be re-created under its "new" name without the duplicate check ever
-- noticing.
--
-- ── THE COLUMN WINS, AND THE SHADOW GOES ────────────────────────────────
-- Every write to the field now updates the COLUMN, and strips the key from
-- `values` while it is there, so the two cannot disagree again. Both writers
-- are patched: the singular one and the coalesced `set_record_values`, which
-- is the one the drawer actually batches through.
--
-- Readers get the column projected back in under the same key, so the field
-- renders exactly as before - `record_values_for()` for the drawer and the
-- `records_filterable` view for the dashboard's filters and sorting.
--
-- The column is taken as the truth for the four drifted records rather than
-- the `values` copy. It is what the dashboard, the drawer title and the
-- uniqueness check have all been showing, so it is the name that was really
-- in effect; the shadow copy was visible on exactly one tab and enforced
-- nothing. That is also precisely what the client asked for - the drawer
-- should agree with the first column, not the other way round.
--
-- A rename to a name another record already holds now trips the unique index
-- as it always has; `setValue` turns that into a refusal sentence rather than
-- a crash (same change).

CREATE OR REPLACE FUNCTION public.set_record_value(p_record_id uuid, p_field_key text, p_new_value jsonb, p_expected_updated_at timestamp with time zone, p_summary text)
 RETURNS TABLE(ok boolean, updated_at timestamp with time zone, current_value jsonb, changed_by uuid, changed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_old    jsonb;
  v_new_at timestamptz;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  -- The grant chain. Placed before the pipeline check on purpose: "you may not
  -- touch this record" is the more basic answer, and answering the narrower
  -- question first would tell an unauthorised caller which fields are
  -- pipeline-synced.
  if record_field_grant(p_record_id, p_field_key) <> 'edit' then
    raise exception 'You do not have edit access to that field.'
      using errcode = '42501';
  end if;

  if is_pipeline_status_key(p_field_key) then
    raise exception 'That Status field follows its pipeline — move the step bar to change it.'
      using errcode = '42501';
  end if;

  /* The previous value, for the history row. Deal Name lives in its own
     COLUMN, so reading `values` for it would record an empty "from". */
  if p_field_key = 'deal_name' then
    select to_jsonb(r.deal_name) into v_old from records r where r.id = p_record_id;
    if nullif(btrim(p_new_value #>> '{}'), '') is null then
      raise exception 'A record must have a Deal Name.' using errcode = '23514';
    end if;
  else
    select r.values -> p_field_key into v_old from records r where r.id = p_record_id;
  end if;

  /* ⚠️ DEAL NAME IS A COLUMN, NOT A KEY IN `values`.
     Writing it into `values` left two copies of the record's name with
     nothing keeping them equal, and four records had already drifted apart.
     The column is the one that carries the unique index, titles the drawer
     and fills the dashboard's frozen first column, so it is the one that is
     written — and the shadow key is stripped on every write, so the two can
     never disagree again. */
  update records
     set deal_name = case
                       when p_field_key = 'deal_name'
                         then btrim(p_new_value #>> '{}')
                       else deal_name
                     end,
         values = case
                    when p_field_key = 'deal_name' then values - 'deal_name'
                    when p_new_value is null or p_new_value = 'null'::jsonb
                      then values - p_field_key
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
            v_old #>> '{}',
            case when p_new_value = 'null'::jsonb then null else p_new_value #>> '{}' end);

    return query select true, v_new_at, null::jsonb, null::uuid, null::timestamptz;
    return;
  end if;

  return query
    select false, r.updated_at,
      case when p_field_key = 'deal_name' then to_jsonb(r.deal_name)
           else r.values -> p_field_key end,
      (select a.actor_id from record_activity a
        where a.record_id = p_record_id and a.kind = 'field' and a.field_key = p_field_key
        order by a.at desc limit 1),
      (select a.at from record_activity a
        where a.record_id = p_record_id and a.kind = 'field' and a.field_key = p_field_key
        order by a.at desc limit 1)
    from records r
    where r.id = p_record_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_record_values(p_record_id uuid, p_changes jsonb, p_expected_updated_at timestamp with time zone, p_summaries jsonb)
 RETURNS TABLE(ok boolean, updated_at timestamp with time zone, current_values jsonb, changed_by uuid, changed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_old      jsonb;
  v_new_at   timestamptz;
  v_clear    text[];
  v_set      jsonb;
  v_synced   text;
  v_denied   text;
  v_deal     text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'no changes supplied';
  end if;

  -- The WHOLE batch is checked before anything is written, matching
  -- `setValues` in the app: a batch touching one forbidden field is refused
  -- entirely rather than partially applied.
  select k into v_denied
    from jsonb_object_keys(p_changes) k
   where record_field_grant(p_record_id, k) <> 'edit'
   limit 1;
  if v_denied is not null then
    raise exception 'You do not have edit access to %.', v_denied
      using errcode = '42501';
  end if;

  select k into v_synced
    from jsonb_object_keys(p_changes) k
   where is_pipeline_status_key(k)
   limit 1;
  if v_synced is not null then
    raise exception 'That Status field follows its pipeline — move the step bar to change it.'
      using errcode = '42501';
  end if;

  /* Deal Name is a COLUMN, not a key in `values` — see the note on the
     update below. Pulled into `v_old` so its history row records the real
     previous name rather than an empty "from". */
  select r.values || jsonb_build_object('deal_name', r.deal_name)
    into v_old
    from records r where r.id = p_record_id;

  if p_changes ? 'deal_name' then
    v_deal := nullif(btrim(p_changes -> 'deal_name' #>> '{}'), '');
    if v_deal is null then
      raise exception 'A record must have a Deal Name.' using errcode = '23514';
    end if;
  end if;

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

  /* ⚠️ DEAL NAME IS A COLUMN, NOT A KEY IN `values`. The same rule as
     `set_record_value`, and it has to be here too: the drawer coalesces its
     writes through THIS function, so fixing only the singular one would have
     left the path a renaming user actually travels still writing the shadow
     copy. The key is stripped unconditionally, so the two cannot drift. */
  update records
     set deal_name  = coalesce(v_deal, deal_name),
         values     = ((values || v_set) - v_clear) - 'deal_name',
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

  -- CAS lost. Hand back only the fields this batch tried to write.
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
$function$;

-- ── READERS SEE THE COLUMN UNDER THE FAMILIAR KEY ───────────────────────
-- Nothing in the application has to learn that Deal Name moved: it is
-- projected back into `values` by the two functions every reader already
-- goes through. Written AFTER the hidden-key strip so a viewer who may not
-- see the field still does not get it.
create or replace function public.record_values_for(p_ids uuid[])
returns table(id uuid, "values" jsonb)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select r.id,
         case
           when 'deal_name' = any(hidden_field_keys_for_record(r.id))
             then r.values - hidden_field_keys_for_record(r.id)
           else (r.values - hidden_field_keys_for_record(r.id))
                || jsonb_build_object('deal_name', r.deal_name)
         end
    from records r
   where r.id = any(p_ids)
     and record_visible(r.id);
$function$;

-- The same projection for the dashboard's filter/sort view (migration 9752).
create or replace view public.records_filterable
with (security_invoker = false) as
  select
    r.id,
    r.deal_name,
    r.creator_kind,
    r.creator_user_id,
    r.creator_campaign_id,
    r.created_at,
    r.updated_at,
    r.deleted_at,
    case
      when 'deal_name' = any(hidden_field_keys_for_record(r.id))
        then r.values - hidden_field_keys_for_record(r.id)
      else (r.values - hidden_field_keys_for_record(r.id))
           || jsonb_build_object('deal_name', r.deal_name)
    end as values,
    coalesce(
      (select array_agg(rm.module_id)
         from public.record_modules rm
        where rm.record_id = r.id),
      '{}'::uuid[]
    ) as module_ids
  from public.records r
 where record_visible(r.id);

revoke all on public.records_filterable from anon, authenticated;
grant select on public.records_filterable to authenticated;

-- ── THE SHADOW COPIES GO ────────────────────────────────────────────────
update public.records
   set values = values - 'deal_name'
 where values ? 'deal_name';

do $$
declare
  leftover int;
begin
  select count(*) into leftover from public.records where values ? 'deal_name';
  if leftover > 0 then
    raise exception 'Deal Name shadow copy still present on % record(s)', leftover;
  end if;
end $$;

commit;
