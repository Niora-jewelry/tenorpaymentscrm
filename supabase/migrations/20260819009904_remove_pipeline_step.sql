-- =============================================================================
-- Removing a pipeline step (client, 4 Nov 2026: "How do I remove a step?").
--
-- Until now a step could only be added: records stand on a step by id
-- (`record_pipelines.step_id`, no cascade), so deleting one would strand them.
-- The client's point is that a record can always be moved, so a step with
-- records on it should not be stuck forever.
--
-- remove_pipeline_step(step, move_to, actor):
--   * the records on the step are moved to `move_to` first: each move writes the
--     same activity row a move on the step bar writes, in this transaction, so
--     the history says where each record went and why;
--   * `move_to` is required when any record stands on the step, and must be
--     another step of the same pipeline;
--   * a pipeline keeps at least one step (the step bar assigns a pipeline by
--     putting the record on its first step);
--   * a step an automation uses (a trigger or an action naming it) is refused
--     with the automation's name: removing it would leave that automation
--     pointing at nothing;
--   * the synced Status field loses the step's option through the existing
--     `pipeline_steps_sync_choices` trigger, and each moved record's value
--     follows its `record_pipelines` row through the existing projection.
--
-- Called by the server only, after the Presets page check (like
-- set_pipeline_steps): execute is revoked from every client role.
-- =============================================================================

create or replace function remove_pipeline_step(p_step_id uuid, p_move_to uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pipeline   uuid;
  v_label      text;
  v_to_label   text;
  v_on         int;
  v_auto       text;
  v_module     text;
  r            record;
begin
  select s.pipeline_id, s.label into v_pipeline, v_label from pipeline_steps s where s.id = p_step_id for update;
  if v_pipeline is null then
    raise exception 'That step no longer exists.' using errcode = '23503';
  end if;
  -- One remove at a time per pipeline: two removes racing could each move
  -- records onto the step the other is deleting.
  perform 1 from pipelines p where p.id = v_pipeline for update;

  if (select count(*) from pipeline_steps s where s.pipeline_id = v_pipeline) <= 1 then
    raise exception 'A pipeline needs at least one step.' using errcode = '23514';
  end if;

  select a.name into v_auto
    from automations a
    join automation_versions v on v.id = a.current_version_id
   where v.steps::text like '%' || p_step_id::text || '%'
   order by a.name
   limit 1;
  if v_auto is not null then
    raise exception 'The automation “%” uses this step. Change or remove it there first.', v_auto using errcode = '23503';
  end if;

  select count(*) into v_on from record_pipelines rp where rp.step_id = p_step_id;
  if v_on > 0 then
    if p_move_to is null then
      raise exception 'Choose the step its % record% move to.', v_on, case when v_on = 1 then '' else 's' end using errcode = '23514';
    end if;
    if p_move_to = p_step_id or not exists (select 1 from pipeline_steps s where s.id = p_move_to and s.pipeline_id = v_pipeline) then
      raise exception 'The records can only move to another step of the same pipeline.' using errcode = '23503';
    end if;
    select label into v_to_label from pipeline_steps where id = p_move_to;

    for r in select rp.record_id, rp.module_id from record_pipelines rp where rp.step_id = p_step_id for update loop
      update record_pipelines set step_id = p_move_to, updated_at = now() where record_id = r.record_id and module_id = r.module_id;
      select label into v_module from modules where id = r.module_id;
      insert into record_activity (record_id, actor_id, kind, summary, from_value, to_value)
      values (r.record_id, p_actor, 'pipeline', 'Pipeline step changed: "' || v_label || '" was removed in Presets', v_label, v_to_label);
    end loop;
  end if;

  delete from pipeline_steps where id = p_step_id;

  -- Close the gap the removed step leaves, keeping the order.
  with ordered as (
    select s.id, row_number() over (order by s.position, s.id) as rn
      from pipeline_steps s where s.pipeline_id = v_pipeline
  )
  update pipeline_steps s set position = (o.rn - 1) * 10 from ordered o where s.id = o.id and s.position <> (o.rn - 1) * 10;

  return jsonb_build_object(
    'moved', v_on,
    'steps', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'swatch', s.swatch, 'position', s.position) order by s.position), '[]'::jsonb)
        from pipeline_steps s where s.pipeline_id = v_pipeline
    )
  );
end;
$$;

revoke execute on function remove_pipeline_step(uuid, uuid, uuid) from public, anon, authenticated;

-- How many records stand on each step, for the editor (server only).
create or replace function pipeline_step_counts(p_pipeline_id uuid)
returns table (step_id uuid, records int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, (select count(*)::int from record_pipelines rp where rp.step_id = s.id)
    from pipeline_steps s where s.pipeline_id = p_pipeline_id;
$$;

revoke execute on function pipeline_step_counts(uuid) from public, anon, authenticated;
