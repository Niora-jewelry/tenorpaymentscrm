-- =============================================================================
-- UI/UX Redesign spec §6 — "Admins can create new fields and choose which
-- fields appear as columns in the record list, without a developer."
--
-- The New field form asks for label, type, tab and section, position (dragged
-- on a preview of the 4-column grid), options, helper text, required, allow
-- notes, auto source, "Show in Vital Info" and "Show as list column". Those
-- land in five tables. Written one RPC at a time, a failure halfway left a
-- field with no options or a column for a field that was never finished; so
-- each admin save is ONE function call and one transaction.
--
--   create_field_with_setup  the whole New field form
--   place_field              move a field to a spot in its tab (the preview drag)
--   set_field_surfaces       Vital Info / list-column membership for one field
--   change_field_type        type change, refused or confirmed when values exist
--
-- All four are SECURITY DEFINER for the service role only: the application
-- calls them after `assertAdmin`, the same contract as set_field_choices.
-- =============================================================================

-- ── place one field after another (null = first in its section / placement) ──
create or replace function place_field(p_field_id uuid, p_after uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tab     uuid;
  v_subtab  uuid;
  v_section text;
  v_ids     uuid[];
  v_at      int;
  v_first   uuid;
begin
  select tab_id, subtab_id, section into v_tab, v_subtab, v_section from fields where id = p_field_id;
  if v_tab is null then raise exception 'That field no longer exists.'; end if;

  -- Everything else in the same tab / sub-tab, in its current order.
  select array_agg(id order by position, created_at) into v_ids
    from fields
   where tab_id = v_tab and subtab_id is not distinct from v_subtab and id <> p_field_id;
  v_ids := coalesce(v_ids, '{}');

  if p_after is not null and p_after = any(v_ids) then
    v_at := array_position(v_ids, p_after);            -- insert after it
  else
    -- "First": before the first field of its own section, or at the end when
    -- the section is new.
    select id into v_first
      from fields
     where tab_id = v_tab and subtab_id is not distinct from v_subtab and id <> p_field_id
       and section is not distinct from v_section
     order by position, created_at
     limit 1;
    v_at := case when v_first is null then cardinality(v_ids) else array_position(v_ids, v_first) - 1 end;
  end if;

  v_ids := v_ids[1:v_at] || p_field_id || v_ids[v_at + 1:];

  update fields f
     set position = o.n * 10
    from unnest(v_ids) with ordinality as o(id, n)
   where f.id = o.id and f.position is distinct from o.n * 10;
end;
$$;

-- ── Vital Info and list columns for ONE field ────────────────────────────────
-- p_vital: in Vital Info in every module (true) or none (false).
-- p_column_modules: the modules whose record list shows it as a column.
create or replace function set_field_surfaces(p_field_id uuid, p_vital boolean, p_column_modules uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_vital then
    insert into module_header_fields (module_id, field_id, position)
    select m.id, p_field_id,
           coalesce((select max(h.position) from module_header_fields h where h.module_id = m.id), 0) + 10
      from modules m
     where not exists (select 1 from module_header_fields h where h.module_id = m.id and h.field_id = p_field_id);
  else
    delete from module_header_fields where field_id = p_field_id;
  end if;

  delete from module_columns
   where field_id = p_field_id
     and not (module_id = any(coalesce(p_column_modules, '{}')));
  insert into module_columns (module_id, field_id, position)
  select m, p_field_id,
         coalesce((select max(c.position) from module_columns c where c.module_id = m), 0) + 10
    from unnest(coalesce(p_column_modules, '{}')) as m
   where not exists (select 1 from module_columns c where c.module_id = m and c.field_id = p_field_id);
end;
$$;

-- ── the whole New field form ──────────────────────────────────────────────────
create or replace function create_field_with_setup(
  p_field          jsonb,
  p_choices        jsonb,
  p_after          uuid,
  p_vital          boolean,
  p_column_modules uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_type field_type := (p_field->>'type')::field_type;
begin
  insert into fields (
    key, label, type, tab_id, subtab_id, position, hint, section,
    required, sensitive, wide, notes_enabled,
    is_system, read_only, sync_enabled, placeholder,
    digits, auto_source, auto_source_field
  ) values (
    p_field->>'key', p_field->>'label', v_type,
    (p_field->>'tab_id')::uuid, nullif(p_field->>'subtab_id', '')::uuid,
    1000000,                                  -- placed properly just below
    nullif(btrim(p_field->>'hint'), ''), nullif(btrim(p_field->>'section'), ''),
    coalesce((p_field->>'required')::boolean, false),
    coalesce((p_field->>'sensitive')::boolean, false),
    false,
    coalesce((p_field->>'notes_enabled')::boolean, false),
    false,
    v_type = 'auto',                          -- an auto field is never editable
    false, false,
    case when jsonb_typeof(p_field->'digits') = 'array'
         then array(select (d)::int from jsonb_array_elements_text(p_field->'digits') d) end,
    nullif(p_field->>'auto_source', ''),
    nullif(p_field->>'auto_source_field', '')
  )
  returning id into v_id;

  if jsonb_typeof(p_choices) = 'array' and jsonb_array_length(p_choices) > 0 then
    perform set_field_choices(v_id, null, p_choices);
  end if;

  perform place_field(v_id, p_after);
  perform set_field_surfaces(v_id, coalesce(p_vital, false), p_column_modules);

  -- An auto field on records that already exist: fill it now, not on their
  -- next edit. The fill trigger does the work; this only wakes it.
  if v_type = 'auto' then
    update records set values = values where deleted_at is null;
  end if;

  return v_id;
end;
$$;

-- ── type change ───────────────────────────────────────────────────────────────
-- Spec §6: "Changing a field's type after it holds data should be blocked or
-- require confirmation, since values may not convert." Both, by pair:
--   * no record holds a value          → any allowed type, no questions;
--   * values exist, the stored shape is the same (text ↔ long text, number ↔
--     currency ↔ percentage, dropdown ↔ status, text → digits-only when every
--     value is digits)                 → allowed only with p_confirm;
--   * anything else with values        → refused.
-- Returns the number of records holding a value, so the form can ask.
create or replace function change_field_type(p_field_id uuid, p_type field_type, p_confirm boolean)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  f        record;
  v_held   int;
  v_from   text;
  v_to     text := p_type::text;
  v_same   boolean;
begin
  select id, key::text as key, type::text as type, is_system into f from fields where id = p_field_id;
  if f.id is null then raise exception 'That field no longer exists.'; end if;
  if f.is_system then raise exception 'A system field keeps its type.'; end if;
  v_from := f.type;
  if v_from = v_to then return 0; end if;
  if v_from in ('repeat_group', 'grid', 'auto') or v_to in ('repeat_group', 'grid', 'auto', 'checkbox', 'datetime') then
    raise exception 'A % field cannot become a %.', v_from, v_to;
  end if;

  select count(*) into v_held
    from records
   where values ? f.key and values->f.key not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb);

  if v_held > 0 then
    v_same := (v_from in ('text', 'long_text') and v_to in ('text', 'long_text'))
           or (v_from in ('number', 'currency', 'percentage') and v_to in ('number', 'currency', 'percentage'))
           or (v_from in ('dropdown', 'status') and v_to in ('dropdown', 'status'))
           or (v_from = 'identifier' and v_to = 'text')
           or (v_from = 'text' and v_to = 'identifier'
               and not exists (select 1 from records where values ? f.key and (values->>f.key) !~ '^[0-9]*$'));
    if not v_same then
      raise exception '% record(s) hold a value that would not convert from % to %. Keep the type, or create a new field.', v_held, v_from, v_to;
    end if;
    if not coalesce(p_confirm, false) then
      return v_held;                           -- the caller asks, then calls again confirmed
    end if;
  end if;

  -- A digit-count rule belongs to digits-only text and nothing else.
  update fields
     set type = p_type,
         digits = case when p_type = 'identifier' then digits end
   where id = p_field_id;
  return 0;
end;
$$;

revoke execute on function place_field(uuid, uuid) from public, anon, authenticated;
revoke execute on function set_field_surfaces(uuid, boolean, uuid[]) from public, anon, authenticated;
revoke execute on function create_field_with_setup(jsonb, jsonb, uuid, boolean, uuid[]) from public, anon, authenticated;
revoke execute on function change_field_type(uuid, field_type, boolean) from public, anon, authenticated;
