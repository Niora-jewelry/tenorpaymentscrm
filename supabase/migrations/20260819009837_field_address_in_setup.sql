-- =============================================================================
-- The per-field address (9836) is a field option like notes, so the admin
-- "new field" path has to carry it: create_field_with_setup takes
-- `address_enabled`. Same body as 9805, one column more.
-- =============================================================================
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
    required, sensitive, wide, notes_enabled, address_enabled,
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
    coalesce((p_field->>'address_enabled')::boolean, false),
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
