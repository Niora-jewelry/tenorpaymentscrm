-- =============================================================================
-- records_filterable.sort_values (migration 9808) was correct and far too slow:
-- the planner folded the "not a hidden field" test into the scan of `fields`,
-- so hidden_field_keys_for_record() ran once per FIELD per record — 154 calls a
-- row, ~65 ms a row, and a filtered list hit the statement timeout (57014).
--
-- A MATERIALIZED CTE inside the per-record subquery is evaluated exactly once
-- per record, so the permission lookup runs once and the field loop reads the
-- result. Same output, same hidden-field stripping.
-- =============================================================================

create or replace view records_filterable
with (security_invoker = false)
as
select r.id,
       r.deal_name,
       r.creator_kind,
       r.creator_user_id,
       r.creator_campaign_id,
       r.created_at,
       r.updated_at,
       r.deleted_at,
       (select (r."values" - k.keys)
               || case
                    when 'deal_name' = any(k.keys) then '{}'::jsonb
                    else jsonb_build_object('deal_name', r.deal_name)
                  end
               || case
                    when 'record_creator' = any(k.keys)
                      or r.creator_kind <> 'user'::creator_kind
                      or r.creator_user_id is null
                      then '{}'::jsonb
                    else jsonb_build_object('record_creator', jsonb_build_array(r.creator_user_id::text))
                  end
          from (select hidden_field_keys_for_record(r.id) as keys) k) as "values",
       coalesce((select array_agg(rm.module_id) from record_modules rm where rm.record_id = r.id),
                '{}'::uuid[]) as module_ids,
       (select coalesce(r.deal_name, '') || ' ' ||
               coalesce((select string_agg(x #>> '{}', ' ')
                           from jsonb_path_query(r."values" - k.keys, 'strict $.**') as x
                          where jsonb_typeof(x) = 'string'), '')
          from (select hidden_field_keys_for_record(r.id) as keys) k) as search_text,
       (with k as materialized (select hidden_field_keys_for_record(r.id) as keys),
             v as materialized (select r."values" - (select keys from k) as vals)
        select coalesce(jsonb_object_agg(f.key::text,
                 case
                   when f.type in ('number', 'currency', 'percentage') then to_jsonb((raw #>> '{}')::numeric)
                   when f.type in ('dropdown', 'status') then to_jsonb(coalesce(
                     (select min(c.position) from field_choices c
                       where c.field_id = f.id and c.key::text = (raw #>> '{}')),
                     1000000))
                   else to_jsonb(raw #>> '{}')
                 end), '{}'::jsonb)
          from v
          join fields f on f.archived_at is null
                       and f.type in ('number', 'currency', 'percentage', 'date', 'dropdown', 'status')
          cross join lateral (select v.vals -> f.key::text as raw) x
         where jsonb_typeof(raw) in ('number', 'string')
           and (raw #>> '{}') <> ''
           and (f.type not in ('number', 'currency', 'percentage')
                or (raw #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$')) as sort_values
  from records r
 where record_visible(r.id);

grant select on public.records_filterable to authenticated;
