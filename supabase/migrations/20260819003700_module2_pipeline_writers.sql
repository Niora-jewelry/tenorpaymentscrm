-- =============================================================================
-- Module 2 — Part 37: the writers for pipelines and their steps, plus the
-- database half of "a pipeline never changes module and a step never changes
-- pipeline".
--
-- Presets sub-step 5 (Admin → Pipelines) creates a pipeline with its steps,
-- renames either, and reorders both — the same full-list-in-one-write posture
-- as migrations 35 and 36, for the same reason: a screen that can leave a
-- pipeline half-written after a failed second round trip is worse than one
-- that cannot save at all.
--
-- ── WHY A PIPELINE CANNOT BE CREATED WITHOUT STEPS ───────────────────────
-- `RealPipelineBar` offers "Assign <pipeline>" for every pipeline on the
-- module and assigns its FIRST step (`p.steps[0]`). A pipeline with no steps
-- therefore renders a button that throws when clicked, and a step bar reading
-- "step 0 of 0" for anyone already on it. `create_pipeline` requires at least
-- one step so that state cannot be authored; the renderer skips step-less
-- pipelines as well, because direct SQL is not the only way to be surprised.
--
-- ── WHY THIS UPSERTS AND NEVER DELETES ───────────────────────────────────
-- `record_pipelines.step_id` references `pipeline_steps` with NO ACTION (not
-- CASCADE — checked against the live database), so removing a step a record
-- sits on already fails as a 23503. That is the right outcome and the wrong
-- error: an admin reads it as the app being broken. More to the point,
-- removing a step NO record sits on today is still a decision about history —
-- `record_activity` holds 'pipeline' entries naming steps by label, and a
-- pipeline is the shape of a process, not a list of options. So this pass
-- ships add / rename / reorder / re-colour and NOT delete, exactly as
-- `remaining-plan.md` § Phase 4 and migration 36 do for choices. The function
-- has no DELETE in it, so no request shape and no future caller can remove a
-- step through it. Deleting a step belongs with the other deferred deletion
-- work, and needs the same question answered: what happens to the records
-- standing on it.
--
-- ── WHY THE TWO PERMANENCE TRIGGERS ──────────────────────────────────────
-- Both guard the same silent failure, from opposite ends. `record_pipelines`
-- is keyed `(record_id, module_id)` and stores `pipeline_id` AND `step_id` as
-- separate columns:
--
--   * Move a pipeline to another module and every existing assignment keeps
--     the OLD module_id. `pipelinesForModule` stops returning it there, so the
--     drawer says "No pipeline on this record in this module" while a row
--     saying otherwise sits in the table — and the new module shows the
--     pipeline with nobody on it.
--   * Move a step to another pipeline and any record holding it now has a
--     (pipeline_id, step_id) pair that does not agree. `RealPipelineBar` finds
--     index -1, renders "step 0 of N", and colours every chip as upcoming. The
--     record still HAS a position; the bar just cannot show it.
--
-- Neither errors. Both are `update`s that no screen offers and that direct SQL
-- can perform in one line, which is precisely the class CLAUDE.md asks to be
-- pushed into the database.
--
-- Naming no module here: these functions take module ids as arguments and read
-- them from rows. CLAUDE.md §1 forbids code naming a module, and none is named.
-- =============================================================================

create or replace function pipelines_module_is_permanent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.module_id is distinct from old.module_id then
    raise exception 'A pipeline belongs to one module permanently — records already assigned to it are filed under that module. Create a pipeline on the other module instead.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger pipelines_module_permanent
  before update of module_id on pipelines
  for each row execute function pipelines_module_is_permanent();

create or replace function pipeline_steps_pipeline_is_permanent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.pipeline_id is distinct from old.pipeline_id then
    raise exception 'A step belongs to one pipeline permanently — records store the step and the pipeline separately, and moving it makes the two disagree.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger pipeline_steps_pipeline_permanent
  before update of pipeline_id on pipeline_steps
  for each row execute function pipeline_steps_pipeline_is_permanent();

-- -----------------------------------------------------------------------------
-- Create a pipeline and its first steps, in one transaction.
--
-- `status_field_id` is deliberately left NULL. The prototype's admin copy
-- describes creating a pipeline as auto-creating a linked Status field whose
-- options are its steps; nothing in this build reads that column — `config.ts`
-- does not even load it, and all four seeded pipelines have it NULL (confirmed
-- against the live database 2026-09-04). Setting it here would store a link no
-- reader honours, which is the same "control with no visible effect" this area
-- has already refused twice (swatches on a dropdown, grid columns beyond the
-- three `GridCell` renders). Wiring synced status up is its own piece of work,
-- and a real one: it has to keep `pipeline_steps` and `field_choices` in step
-- while records store a choice KEY on one side and a step ID on the other.
--
-- Positions step by 10 within the module, matching migrations 35 and 36 and
-- the seed's own scale.
--
-- `security definer` with a pinned `search_path` per CLAUDE.md §8, reachable
-- only through the service role (migration 19's convention): the admin check is
-- `assertAdmin(ctx)` in `adminPipelines.ts`, and no browser-side role has any
-- reason to call this directly.
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

  return v_pipeline_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Replace a pipeline's whole ordered step list — add, rename, re-colour,
-- reorder. Never remove; see the header.
--
-- An entry with no `id` is a new step and is given one. An entry WITH an id
-- must already belong to this pipeline: an id from another pipeline is refused
-- rather than silently re-parented, which is the same rule the permanence
-- trigger enforces against direct SQL, checked here so the caller gets a
-- sentence instead of a trigger message it did not expect.
--
-- Returns the steps AS STORED so the editor can adopt the ids the database
-- assigned. Without that, a form saving twice would submit the same blank id
-- again and mint a SECOND step instead of editing the first — migration 36's
-- rule, one identity column over.
--
-- The return is `jsonb` rather than `returns table (…)` for a plain syntactic
-- reason worth recording: `position` is a reserved column name in a RETURNS
-- TABLE list, and output parameters named after the columns being selected
-- shadow them inside the body besides.
-- -----------------------------------------------------------------------------

create or replace function set_pipeline_steps(p_pipeline_id uuid, p_steps jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_elem record;
  v_id   uuid;
  -- Every step this call wrote, new ones included. A step inserted in the loop
  -- has an id that appears nowhere in the SUBMITTED list (it was submitted
  -- blank), so a "which rows did the caller not name" test built from the
  -- input alone counts it as untouched and pushes the step it just created to
  -- the end. Collecting the ids as they are written is what makes that test
  -- mean what it says.
  v_kept uuid[] := '{}';
begin
  if not exists (select 1 from pipelines p where p.id = p_pipeline_id) then
    raise exception 'That pipeline no longer exists.' using errcode = '23503';
  end if;

  if p_steps is null or jsonb_array_length(p_steps) = 0 then
    raise exception 'A pipeline needs at least one step.' using errcode = '23514';
  end if;

  for v_elem in select val, ord from jsonb_array_elements(p_steps) with ordinality as t(val, ord)
  loop
    v_id := nullif(v_elem.val->>'id', '')::uuid;

    if v_id is null then
      insert into pipeline_steps (pipeline_id, label, swatch, position)
      values (p_pipeline_id, v_elem.val->>'label', (v_elem.val->>'swatch')::swatch, (v_elem.ord - 1) * 10)
      returning id into v_id;
    else
      update pipeline_steps s
         set label    = v_elem.val->>'label',
             swatch   = (v_elem.val->>'swatch')::swatch,
             position = (v_elem.ord - 1) * 10
       where s.id = v_id and s.pipeline_id = p_pipeline_id;

      if not found then
        raise exception 'That step is not part of this pipeline.' using errcode = '23503';
      end if;
    end if;

    v_kept := v_kept || v_id;
  end loop;

  -- A step the caller did not list still exists — this function never deletes —
  -- but it cannot be left holding a position the submitted list has just
  -- reused. Two steps sharing a position order arbitrarily between renders,
  -- which reads as a reordering bug with no visible cause. They keep their
  -- relative order and land after everything submitted, which is the honest
  -- answer for a step the caller did not know about (one created concurrently,
  -- from another session, after this form was loaded).
  with untouched as (
    select s.id, row_number() over (order by s.position, s.id) as rn
      from pipeline_steps s
     where s.pipeline_id = p_pipeline_id
       and not (s.id = any(v_kept))
  )
  update pipeline_steps s
     set position = array_length(v_kept, 1) * 10 + (u.rn - 1) * 10
    from untouched u
   where s.id = u.id;

  return (
    select coalesce(
             jsonb_agg(
               jsonb_build_object('id', s.id, 'label', s.label, 'swatch', s.swatch, 'position', s.position)
               order by s.position
             ),
             '[]'::jsonb
           )
      from pipeline_steps s
     where s.pipeline_id = p_pipeline_id
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Reorder the pipelines within ONE module.
--
-- Scoped to the module in the WHERE clause, so a list containing another
-- module's pipeline reorders nothing rather than dragging it across — the same
-- rule as the permanence trigger, expressed as a filter. Only pipelines named
-- in the array move; one omitted keeps the position it had.
-- -----------------------------------------------------------------------------

create or replace function set_pipeline_order(p_module_id uuid, p_pipeline_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update pipelines p
     set position = (v.ord - 1) * 10
    from unnest(p_pipeline_ids) with ordinality as v(pipeline_id, ord)
   where p.id = v.pipeline_id
     and p.module_id = p_module_id;
end;
$$;

revoke execute on function create_pipeline(uuid, text, jsonb)     from public, anon, authenticated;
revoke execute on function set_pipeline_steps(uuid, jsonb)        from public, anon, authenticated;
revoke execute on function set_pipeline_order(uuid, uuid[])       from public, anon, authenticated;
