begin;

-- ════════════════════════════════════════════════════════════════════════
-- "Record creator" stops showing a dash
-- ════════════════════════════════════════════════════════════════════════
--
-- The client: "Record creator field (tab overview) did not register that
-- Izzy created Yeshivas Netzach Yisroel NFP in contacts tab".
--
-- It had registered it. `createRecord` writes `records.creator_kind` and
-- `records.creator_user_id` on the insert, and both were correctly set to
-- him. But `record_creator` is also a FIELD, and the drawer reads fields out
-- of `values` — where nothing has ever written it. So the card rendered the
-- empty-value dash while the answer sat one column away.
--
-- Exactly the shape of the Deal Name problem in …9755, and it takes the same
-- answer: the column is the storage, and readers get it projected back under
-- the key the field already uses. No second copy, so nothing can drift.
--
-- ── WHY AN ARRAY, AND WHY ONLY `user` ───────────────────────────────────
-- The field's type is `team_member`, whose value is an array of user ids, so
-- a bare uuid would render as nothing at all.
--
-- `creator_kind` also allows `campaign`, for a record a marketing campaign
-- created. That id is not a user and would resolve to an unknown person, so
-- it is deliberately NOT projected: a dash saying "not a person" is honest,
-- where somebody else's avatar would not be. Every record today is
-- `creator_kind = 'user'` (34 of 34, checked), so nothing currently relies on
-- the campaign case; when the first one arrives it wants its own control
-- showing the campaign's NAME, not a person-shaped hole.
--
-- The field is already `read_only` and `is_system`, so there is no write path
-- to keep in step — `assertWritable` refuses one, and the spec is explicit:
-- "set on creation, never editable, and grants no visibility".

create or replace function public.record_values_for(p_ids uuid[])
returns table(id uuid, "values" jsonb)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select r.id,
         (r.values - hidden_field_keys_for_record(r.id))
         || case
              when 'deal_name' = any(hidden_field_keys_for_record(r.id)) then '{}'::jsonb
              else jsonb_build_object('deal_name', r.deal_name)
            end
         || case
              when 'record_creator' = any(hidden_field_keys_for_record(r.id))
                or r.creator_kind <> 'user'
                or r.creator_user_id is null
                then '{}'::jsonb
              else jsonb_build_object(
                     'record_creator', jsonb_build_array(r.creator_user_id::text))
            end
    from records r
   where r.id = any(p_ids)
     and record_visible(r.id);
$function$;

-- The dashboard's filter/sort view gets the same two projections, so a column
-- or filter on either reads what the drawer reads.
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
    (r.values - hidden_field_keys_for_record(r.id))
    || case
         when 'deal_name' = any(hidden_field_keys_for_record(r.id)) then '{}'::jsonb
         else jsonb_build_object('deal_name', r.deal_name)
       end
    || case
         when 'record_creator' = any(hidden_field_keys_for_record(r.id))
           or r.creator_kind <> 'user'
           or r.creator_user_id is null
           then '{}'::jsonb
         else jsonb_build_object(
                'record_creator', jsonb_build_array(r.creator_user_id::text))
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

-- Any stale copy somebody wrote into `values` before this: the column is the
-- storage now, so the shadow goes the same way Deal Name's did.
update public.records set values = values - 'record_creator'
 where values ? 'record_creator';

commit;
