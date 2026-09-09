-- =============================================================================
-- Part 62: stop the synced Status field saying "the Lead Pipeline pipeline".
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────
-- Migration 57 builds the hint as `'… with the ' || label || ' pipeline.'`,
-- which is right for a pipeline called "Account Health" and wrong for the three
-- that are already called "… Pipeline":
--
--     Kept in step with the Lead Pipeline pipeline.
--     Kept in step with the Deal Pipeline pipeline.
--     Kept in step with the Support Pipeline pipeline.
--
-- Small, and worth fixing precisely because this field is the one people find
-- confusing: a record can show "Current Status: Qualified" in the header and
-- "Lead Pipeline Status: brimesh" below it, and the hint is the sentence that
-- has to explain why those two are allowed to differ. A sentence that stutters
-- is not the one to explain anything with.
--
-- ── THE FIX IS A FUNCTION, NOT A STRING ──────────────────────────────────
-- The wording is needed in two places — the field is created in one and renamed
-- in another — and the last version of this drifted between them. One helper,
-- called from both, so it cannot.
-- =============================================================================

create or replace function pipeline_status_hint(p_label text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select 'Follows the '
      || p_label
      -- Only add the noun when the name does not already end in it.
      || case when lower(btrim(p_label)) like '%pipeline' then '' else ' pipeline' end
      || '. Move the step bar at the top of this record to change it.';
$$;

create or replace function ensure_pipeline_status_field(p_pipeline_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_field    uuid;
  v_module   uuid;
  v_slug     text;
  v_label    text;
  v_tab      uuid;
  v_key      text;
  v_position int;
begin
  select p.status_field_id, p.module_id, p.label
    into v_field, v_module, v_label
    from pipelines p where p.id = p_pipeline_id;

  if v_module is null then
    raise exception 'That pipeline no longer exists.' using errcode = '23503';
  end if;

  if v_field is not null then
    perform sync_pipeline_status_choices(p_pipeline_id);
    return v_field;
  end if;

  select m.slug into v_slug from modules m where m.id = v_module;

  select t.id into v_tab
    from module_tab_order o
    join tabs t on t.id = o.tab_id
   where o.module_id = v_module
     and t.accepts_fields
   order by o.position
   limit 1;

  if v_tab is null then
    raise exception 'This module has no tab that accepts fields, so a synced Status field has nowhere to live.'
      using errcode = '23514';
  end if;

  v_key := pipeline_status_field_key(v_slug, v_label);
  select coalesce(max(f.position), 0) + 10 into v_position from fields f where f.tab_id = v_tab;

  insert into fields (key, label, type, tab_id, subtab_id, position, hint,
                      is_system, read_only, width)
  values (v_key,
          -- "Lead Pipeline Status", not "Lead Pipeline Pipeline Status".
          v_label || case when lower(btrim(v_label)) like '%pipeline' then '' else ' Pipeline' end || ' Status',
          'status', v_tab, null, v_position,
          pipeline_status_hint(v_label),
          true, true, 160)
  returning id into v_field;

  update pipelines set status_field_id = v_field where id = p_pipeline_id;

  perform sync_pipeline_status_choices(p_pipeline_id);
  return v_field;
end;
$$;

create or replace function pipelines_sync_status_label()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status_field_id is not null and new.label is distinct from old.label then
    update fields
       set label = new.label
                || case when lower(btrim(new.label)) like '%pipeline' then '' else ' Pipeline' end
                || ' Status',
           hint  = pipeline_status_hint(new.label)
     where id = new.status_field_id;
  end if;
  return new;
end;
$$;

-- Existing fields keep their labels (renaming one now would change a column
-- header an admin may already have arranged around) and get the corrected hint.
update fields f
   set hint = pipeline_status_hint(p.label)
  from pipelines p
 where p.status_field_id = f.id;

revoke execute on function pipeline_status_hint(text) from public, anon, authenticated;

comment on function pipeline_status_hint(text) is
  'The one place the synced Status field explains itself. Shared by the '
  'creator and the rename trigger so the two cannot drift.';
