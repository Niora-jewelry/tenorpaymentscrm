-- =============================================================================
-- Search a module's list by name — records_filterable.search_text
-- =============================================================================
-- Client request, 23 Oct 2026: "add a function to search for contact name …
-- add this to all modules". Every module list (and the Records List) gets a
-- search box; this is the column it searches.
--
-- `search_text` is the record's name followed by every STRING value in the
-- record — top-level fields and the entries inside repeating groups (a
-- contact's name, an affiliate's email …) — with no JSON keys in it, so
-- "name" does not match every record. It is built from the same values
-- expression the view already exposes: `values` stripped of the keys this
-- viewer may not see. A value the viewer cannot see therefore cannot match,
-- and a search can never reveal that a hidden field holds something
-- (CLAUDE.md §3: absent from the query, never hidden after the fact).
--
-- Same columns in the same order as 9763, plus the new one at the end — the
-- only shape `create or replace view` accepts. The scalar subquery is only
-- evaluated when `search_text` is referenced, so an unsearched list costs
-- nothing extra.
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
          from (select hidden_field_keys_for_record(r.id) as keys) k) as search_text
  from records r
 where record_visible(r.id);

comment on view public.records_filterable is
  'records, scoped to the caller exactly as the records SELECT policy does, with `values` stripped of the caller''s hidden field keys, and `search_text` (the name plus every visible string value, no keys) for the list search. Discloses nothing beyond record_values_for().';

revoke all on public.records_filterable from anon, authenticated;
grant select on public.records_filterable to authenticated;
