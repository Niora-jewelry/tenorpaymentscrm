-- =============================================================================
-- UI/UX Redesign spec §6 — "Make a field a list column".
--
--   * "The admin sets the column's default order and whether it is visible by
--     default."                          → module_columns.default_visible
--   * "Users can still hide or show columns for their own view."
--                                         → user_column_visibility
--   * "Columns should be sortable and filterable by their value where the
--     type allows (Dropdown, Status, Date, Number, Currency)."
--                                         → records_filterable.sort_values
--
-- ── WHY A sort_values COLUMN ────────────────────────────────────────────────
-- Filters read `values->>key`, which is TEXT: a range filter on a number
-- compared "9" > "100", and the stored values are a mix of JSON numbers and
-- numeric strings, so even `values->key` would order a string after every
-- number. `sort_values` holds, per field the viewer may see, a value that
-- compares correctly as jsonb:
--     number / currency / percentage → a JSON number
--     date                           → the ISO date string
--     dropdown / status              → the option's position in its list
--                                      (the global list, or a module's own when
--                                      the options are per module), so a column
--                                      sorts in the order the options were set
-- Built from the same hidden-key-stripped `values` as every other column of
-- this view, so a hidden field neither sorts nor filters (spec: "If a field is
-- hidden, its column is hidden in lists and it can't be searched").
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
       (select coalesce(jsonb_object_agg(f.key::text,
                 case
                   when f.type in ('number', 'currency', 'percentage') then to_jsonb((v.raw #>> '{}')::numeric)
                   when f.type in ('dropdown', 'status') then to_jsonb(coalesce(
                     (select min(c.position) from field_choices c
                       where c.field_id = f.id and c.key::text = (v.raw #>> '{}')),
                     1000000))
                   else to_jsonb(v.raw #>> '{}')
                 end), '{}'::jsonb)
          from (select hidden_field_keys_for_record(r.id) as keys) k
          join fields f on f.archived_at is null
                       and f.type in ('number', 'currency', 'percentage', 'date', 'dropdown', 'status')
                       and not (f.key::text = any(k.keys))
          cross join lateral (select r."values" -> f.key::text as raw) v
         where jsonb_typeof(v.raw) in ('number', 'string')
           and (v.raw #>> '{}') <> ''
           and (f.type not in ('number', 'currency', 'percentage')
                or (v.raw #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$')) as sort_values
  from records r
 where record_visible(r.id);

comment on view public.records_filterable is
  'records as this viewer may see them: values stripped of hidden fields, the record''s display modules, the search text, and typed sort/filter values (migration 9808).';
grant select on public.records_filterable to authenticated;

-- ── default visibility, per module ──────────────────────────────────────────
alter table module_columns add column if not exists default_visible boolean not null default true;
comment on column module_columns.default_visible is
  'Shown in the record list until a user hides it (UI/UX spec §6). Off = available, hidden by default.';

-- set_module_columns replaces a module's whole list. It deleted and
-- re-inserted every row, which would reset each column's default visibility
-- on every save; the flags of columns that stay are now carried across.
create or replace function set_module_columns(p_module_id uuid, p_field_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keep jsonb;
begin
  select coalesce(jsonb_object_agg(mc.field_id::text, mc.default_visible), '{}'::jsonb) into v_keep
    from module_columns mc where mc.module_id = p_module_id;

  delete from module_columns mc
    using fields f
   where mc.module_id = p_module_id
     and f.id = mc.field_id
     and f.archived_at is null;

  -- The join is the validation: an id that is not a live field is dropped
  -- rather than raising, so a stale form saves the rest of the ordering.
  insert into module_columns (module_id, field_id, position, default_visible)
  select p_module_id, v.field_id, (v.ord - 1) * 10, coalesce((v_keep ->> v.field_id::text)::boolean, true)
    from unnest(p_field_ids) with ordinality as v(field_id, ord)
    join fields f on f.id = v.field_id
   where f.archived_at is null;
end;
$$;

-- ── each user's own show / hide ─────────────────────────────────────────────
create table if not exists user_column_visibility (
  user_id   uuid not null references profiles(id) on delete cascade,
  module_id uuid not null references modules(id) on delete cascade,
  field_id  uuid not null references fields(id) on delete cascade,
  visible   boolean not null,
  primary key (user_id, module_id, field_id)
);
alter table user_column_visibility enable row level security;
alter table user_column_visibility force row level security;
drop policy if exists user_column_visibility_own on user_column_visibility;
create policy user_column_visibility_own on user_column_visibility
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
revoke all on user_column_visibility from anon;
grant select, insert, update, delete on user_column_visibility to authenticated;
comment on table user_column_visibility is
  'A user''s own choice to show or hide a list column, over the module''s default (UI/UX spec §6).';

-- ── the admin setter for one column's default ──────────────────────────────
create or replace function set_module_column_default_visible(p_module_id uuid, p_field_id uuid, p_visible boolean)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update module_columns set default_visible = p_visible
   where module_id = p_module_id and field_id = p_field_id;
$$;
revoke execute on function set_module_column_default_visible(uuid, uuid, boolean) from public, anon, authenticated;
