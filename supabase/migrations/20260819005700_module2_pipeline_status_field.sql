-- =============================================================================
-- Module 2 — Part 57: the synced Status field a pipeline is supposed to create.
--
-- ── THE REQUIREMENT ──────────────────────────────────────────────────────
-- Admin Plan §3.6: "Synced Status field: creating a pipeline auto-creates a
-- linked Status field whose options are the pipeline's steps — one source of
-- truth. That Status field is visible only on records assigned to that
-- pipeline."
-- Admin Plan §3.6 again, and Modules §2 Filtering: "module dashboards can be
-- filtered by pipeline, and by step via the synced Status field's standard
-- column filter."
--
-- `pipelines.status_field_id` has existed since migration 2 and has been NULL
-- on every row since. Migration 37 deliberately left it that way and wrote down
-- why: wiring it up "has to keep `pipeline_steps` and `field_choices` in step
-- while records store a choice KEY on one side and a step ID on the other."
-- This migration answers exactly that, and the answer is: make them the same
-- thing.
--
-- ── ONE SOURCE OF TRUTH, TAKEN LITERALLY ─────────────────────────────────
-- Nothing here is a copy that can drift, because nothing here is independently
-- writable. Two projections, each with one writer:
--
--   OPTIONS   `field_choices` for the synced field are a projection of
--             `pipeline_steps`. The choice KEY IS THE STEP ID. That is the
--             whole trick — a step rename becomes one UPDATE of `value` and
--             touches zero record rows, which is the rule migration 2 already
--             set down for choices ("stored and looked up by a stable KEY,
--             never by the display label").
--
--   VALUE     `records.values[<field key>]` is a projection of
--             `record_pipelines.step_id`. Moving the step bar writes
--             `record_pipelines`; the trigger below writes the field. There is
--             no second path, and the two write functions refuse the key
--             outright so a hand-crafted request cannot open one.
--
-- Because the stored value is a step id and the choices are keyed by step id,
-- the standard column filter needs no special case whatsoever — it filters this
-- field the way it filters any other Status field, which is precisely what
-- "by step via the synced Status field's standard column filter" asks for.
--
-- ── WHY THE FIELD IS PLACED BY CONFIGURATION, NOT BY NAME ────────────────
-- The field needs a home tab (`fields.tab_id` is NOT NULL). CLAUDE.md §1
-- forbids code naming a module and the same spirit rules out hardcoding a tab
-- key here, so the home is resolved: the first tab in the module's OWN tab
-- order that accepts fields. No literal tab key appears below.
--
-- ── WHY `records.updated_at` IS NOT BUMPED ───────────────────────────────
-- The drawer holds a compare-and-swap token read from `records.updated_at`.
-- Moving the step bar and then editing a field happen in the same open drawer;
-- if the projection bumped the token, that second edit would lose a
-- compare-and-swap against a change the very same user had just made through
-- another control, and be told somebody else got there first. The projection
-- writes `values` and leaves the token alone. `record_pipelines.updated_at` is
-- still the timestamp of record for a step move, as it always was.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A stable, readable, unique key for the generated field.
-- -----------------------------------------------------------------------------
create or replace function pipeline_status_field_key(p_module_slug text, p_label text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_base text;
  v_try  text;
  v_n    int := 1;
begin
  v_base := lower(p_module_slug) || '_' || lower(p_label) || '_status';
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '_', 'g');
  v_base := trim(both '_' from v_base);
  v_base := left(v_base, 55);

  v_try := v_base;
  -- `fields.key` is citext UNIQUE across the whole CRM, and two modules may
  -- each have a pipeline called "Standard". Suffix until free.
  while exists (select 1 from fields f where f.key = v_try::citext) loop
    v_n := v_n + 1;
    v_try := v_base || '_' || v_n;
  end loop;

  return v_try;
end;
$$;

-- -----------------------------------------------------------------------------
-- Rebuild one pipeline's choices from its steps. Idempotent.
-- -----------------------------------------------------------------------------
create or replace function sync_pipeline_status_choices(p_pipeline_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_field  uuid;
  v_module uuid;
begin
  select p.status_field_id, p.module_id into v_field, v_module
    from pipelines p where p.id = p_pipeline_id;
  if v_field is null then
    return;   -- pipeline predates its field, or is being created right now
  end if;

  -- Scoped to the pipeline's module: `choicesFor()` prefers a module-scoped
  -- set over the global one, and a pipeline belongs to exactly one module, so
  -- the field correctly offers nothing anywhere else.
  insert into field_choices (field_id, module_id, key, value, swatch, position)
  select v_field, v_module, s.id::text, s.label, s.swatch, s.position
    from pipeline_steps s
   where s.pipeline_id = p_pipeline_id
  on conflict (field_id, module_id, key) do update
    set value    = excluded.value,
        swatch   = excluded.swatch,
        position = excluded.position;

  -- A step that no longer exists loses its option. `set_pipeline_steps` never
  -- deletes a step, so in practice this only fires for direct SQL — but a
  -- choice pointing at a step that is gone is an option a user can select and
  -- a filter can match, and it must not outlive its step.
  delete from field_choices c
   where c.field_id = v_field
     and c.module_id = v_module
     and not exists (
       select 1 from pipeline_steps s
        where s.pipeline_id = p_pipeline_id and s.id::text = c.key::text
     );
end;
$$;

-- -----------------------------------------------------------------------------
-- Create the field for a pipeline that has none, then fill in its options.
-- Idempotent: called on create, and again by the backfill.
-- -----------------------------------------------------------------------------
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

  -- The home tab, resolved from configuration rather than named. First in the
  -- module's own tab order that can hold fields at all.
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

  -- is_system: generated, not admin-authored, so the Presets field editor
  -- treats it the way it treats Deal Name.
  -- read_only: the step bar is the control. Two writers for one value is the
  -- drift this whole migration exists to prevent.
  insert into fields (key, label, type, tab_id, subtab_id, position, hint,
                      is_system, read_only, width)
  values (v_key, v_label || ' Status', 'status', v_tab, null, v_position,
          'Kept in step with the ' || v_label || ' pipeline. Move the step bar to change it.',
          true, true, 160)
  returning id into v_field;

  update pipelines set status_field_id = v_field where id = p_pipeline_id;

  perform sync_pipeline_status_choices(p_pipeline_id);
  return v_field;
end;
$$;

-- -----------------------------------------------------------------------------
-- Triggers: the steps keep the options honest, the assignment keeps the value
-- honest, and a renamed pipeline renames its field.
-- -----------------------------------------------------------------------------
create or replace function pipeline_steps_sync_choices()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform sync_pipeline_status_choices(coalesce(new.pipeline_id, old.pipeline_id));
  return null;
end;
$$;

drop trigger if exists pipeline_steps_sync_choices on pipeline_steps;
create trigger pipeline_steps_sync_choices
  after insert or update or delete on pipeline_steps
  for each row execute function pipeline_steps_sync_choices();

create or replace function pipelines_sync_status_label()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status_field_id is not null and new.label is distinct from old.label then
    update fields
       set label = new.label || ' Status',
           hint  = 'Kept in step with the ' || new.label || ' pipeline. Move the step bar to change it.'
     where id = new.status_field_id;
  end if;
  return new;
end;
$$;

drop trigger if exists pipelines_sync_status_label on pipelines;
create trigger pipelines_sync_status_label
  after update of label on pipelines
  for each row execute function pipelines_sync_status_label();

-- The value projection. One writer, and this is it.
create or replace function record_pipelines_sync_status_value()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_key text;
  v_new_key text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select f.key into v_old_key
      from pipelines p join fields f on f.id = p.status_field_id
     where p.id = old.pipeline_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select f.key into v_new_key
      from pipelines p join fields f on f.id = p.status_field_id
     where p.id = new.pipeline_id;
  end if;

  -- Reassigned to a DIFFERENT pipeline, or unassigned entirely: the old
  -- pipeline's field must not keep a value. Its step is not where this record
  -- stands any more, and leaving it would let a dashboard filter on the old
  -- pipeline's step still match.
  if v_old_key is not null and v_old_key is distinct from v_new_key then
    update records set values = values - v_old_key where id = old.record_id;
  end if;

  if v_new_key is not null then
    update records
       set values = jsonb_set(values, array[v_new_key], to_jsonb(new.step_id::text), true)
     where id = new.record_id;
  end if;

  return null;
end;
$$;

drop trigger if exists record_pipelines_sync_status_value on record_pipelines;
create trigger record_pipelines_sync_status_value
  after insert or update or delete on record_pipelines
  for each row execute function record_pipelines_sync_status_value();

-- -----------------------------------------------------------------------------
-- The two write functions refuse the key.
--
-- `read_only` on the field is what the drawer honours; this is what makes it
-- true. A synced status value has exactly one writer (the trigger above), and a
-- request that names the key directly is either a mistake or an attempt to
-- desynchronise the two sides — both get the same sentence.
-- -----------------------------------------------------------------------------
create or replace function is_pipeline_status_key(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from pipelines p join fields f on f.id = p.status_field_id
     where f.key = p_key::citext
  );
$$;

create or replace function set_record_values(
  p_record_id           uuid,
  p_changes             jsonb,
  p_expected_updated_at timestamptz,
  p_summaries           jsonb
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
  v_synced   text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'no changes supplied';
  end if;

  select k into v_synced
    from jsonb_object_keys(p_changes) k
   where is_pipeline_status_key(k)
   limit 1;
  if v_synced is not null then
    raise exception 'That Status field follows its pipeline — move the step bar to change it.'
      using errcode = '42501';
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
$$;

-- The single-field path gets the same refusal. Body otherwise unchanged from
-- migration 45.
create or replace function set_record_value(
  p_record_id           uuid,
  p_field_key           text,
  p_new_value           jsonb,
  p_expected_updated_at timestamptz,
  p_summary             text
)
returns table (
  ok            boolean,
  updated_at    timestamptz,
  current_value jsonb,
  changed_by    uuid,
  changed_at    timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old    jsonb;
  v_new_at timestamptz;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  if is_pipeline_status_key(p_field_key) then
    raise exception 'That Status field follows its pipeline — move the step bar to change it.'
      using errcode = '42501';
  end if;

  select r.values -> p_field_key into v_old from records r where r.id = p_record_id;

  update records
     set values = case
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
    select false, r.updated_at, r.values -> p_field_key,
      (select a.actor_id from record_activity a
        where a.record_id = p_record_id and a.kind = 'field' and a.field_key = p_field_key
        order by a.at desc limit 1),
      (select a.at from record_activity a
        where a.record_id = p_record_id and a.kind = 'field' and a.field_key = p_field_key
        order by a.at desc limit 1)
    from records r
    where r.id = p_record_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- create_pipeline now creates the field too. Body otherwise unchanged from
-- migration 37.
-- -----------------------------------------------------------------------------
create or replace function create_pipeline(p_module_id uuid, p_label text, p_steps jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline_id uuid;
  v_position    int;
begin
  if not exists (select 1 from modules m where m.id = p_module_id) then
    raise exception 'That module no longer exists.' using errcode = '23503';
  end if;

  if p_steps is null or jsonb_array_length(p_steps) = 0 then
    raise exception 'A pipeline needs at least one step — an empty one renders a bar with nothing to assign.'
      using errcode = '23514';
  end if;

  select coalesce(max(p.position), -10) + 10 into v_position from pipelines p where p.module_id = p_module_id;

  insert into pipelines (module_id, label, position, status_field_id)
  values (p_module_id, p_label, v_position, null)
  returning id into v_pipeline_id;

  insert into pipeline_steps (pipeline_id, label, swatch, position)
  select v_pipeline_id, elem.val->>'label', (elem.val->>'swatch')::swatch, (elem.ord - 1) * 10
    from jsonb_array_elements(p_steps) with ordinality as elem(val, ord);

  -- "creating a pipeline auto-creates a linked Status field" — Admin §3.6.
  perform ensure_pipeline_status_field(v_pipeline_id);

  return v_pipeline_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Backfill: every pipeline that already exists gets its field, its options,
-- and its records' values.
-- -----------------------------------------------------------------------------
do $$
declare
  v_id  uuid;
  v_key text;
begin
  for v_id in select id from pipelines order by module_id, position loop
    perform ensure_pipeline_status_field(v_id);

    select f.key into v_key
      from pipelines p join fields f on f.id = p.status_field_id
     where p.id = v_id;

    update records r
       set values = jsonb_set(r.values, array[v_key], to_jsonb(rp.step_id::text), true)
      from record_pipelines rp
     where rp.record_id = r.id
       and rp.pipeline_id = v_id;
  end loop;
end;
$$;

revoke execute on function pipeline_status_field_key(text, text)  from public, anon, authenticated;
revoke execute on function sync_pipeline_status_choices(uuid)     from public, anon, authenticated;
revoke execute on function ensure_pipeline_status_field(uuid)     from public, anon, authenticated;
revoke execute on function is_pipeline_status_key(text)           from public;
grant  execute on function is_pipeline_status_key(text)           to authenticated;

comment on function ensure_pipeline_status_field(uuid) is
  'Admin §3.6 synced Status field. The choice KEY is the step id, so a step '
  'rename touches zero record rows and the standard column filter works with '
  'no special case.';
