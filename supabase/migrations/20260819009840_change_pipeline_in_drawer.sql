-- =============================================================================
-- Change Pipeline in Drawer (client spec, 29 Oct 2026).
--
-- One new Yes/No permission, "Change pipeline in drawer" (action.pipeline_change):
-- it covers moving a record to a DIFFERENT pipeline and Remove. Moving along
-- the stages of the pipeline it is on stays under action.pipeline. Every
-- user type defaults to Yes except Accounting (the spec's "Reconciler").
--
-- A change writes the activity row AND an Updates post — old pipeline, new
-- pipeline, starting stage, module, who — in the same transaction.
-- =============================================================================

create or replace function permission_setting_valid(p_key text, p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key ~ '^action\.(create|team|archive|modules|pipeline|pipeline_change)$' then p_value in ('yes', 'no')
    when p_key ~ '^module:[0-9a-f-]{36}$'                          then p_value in ('hidden', 'mine', 'all')
    when p_key in ('notifications.scope', 'email.scope', 'phone.scope') then p_value in ('own', 'all')
    when p_key ~ '^admin\.(users|permissions|presets|numbers|residuals|integrations|automations|recycle_bin)$'
                                                                    then p_value in ('hidden', 'full')
    when p_key = 'communication.scope'                              then p_value in ('own', 'org')
    when p_key = 'items.cases'                                      then p_value in ('hidden', 'mine', 'all')
    when p_key in ('items.updates', 'items.notes')                  then p_value in ('mine', 'all')
    when p_key = 'applications.pdfs'                                then p_value in ('hidden', 'full')
    when p_key = 'agreements.send'                                  then p_value in ('yes', 'no')
    else false
  end;
$$;

create or replace function user_permissions(u uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'superAdmin', user_is_admin(u),
    'userType', (select pt.user_type from user_templates ut join permission_templates pt on pt.id = ut.template_id where ut.user_id = u),
    'settings', (
      select jsonb_object_agg(k, user_perm(u, k))
        from unnest(array[
          'action.create', 'action.team', 'action.archive', 'action.modules', 'action.pipeline', 'action.pipeline_change',
          'notifications.scope', 'email.scope', 'phone.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes',
          'applications.pdfs', 'agreements.send'
        ]) as k
    ),
    'modules', (select coalesce(jsonb_object_agg(m.id::text, user_module_scope(u, m.id)), '{}'::jsonb) from modules m)
  );
$$;

-- Spec: Yes for every user type except Reconciler (Accounting here).
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'action.pipeline_change', case when pt.user_type = 'accounting' then 'no' else 'yes' end
  from permission_templates pt
 where pt.user_type is not null and pt.user_type <> 'super_admin'
on conflict (owner_kind, owner_id, key) do nothing;

create or replace function require_pipeline_change()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_is_admin() and auth_perm('action.pipeline_change') <> 'yes' then
    raise exception 'You do not have permission to change or remove a record''s pipeline.'
      using errcode = '42501';
  end if;
end;
$$;
revoke execute on function require_pipeline_change() from public, anon;
grant execute on function require_pipeline_change() to authenticated;

create or replace function set_pipeline_step(p_record_id uuid, p_module_id uuid, p_pipeline_id uuid, p_step_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_label   text;
  v_old_pipeline uuid;
  v_old_label    text;
  v_new_label    text;
  v_module_label text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_module_edit_on_record(p_record_id, p_module_id);
  if not exists (select 1 from pipelines p where p.id = p_pipeline_id and p.module_id = p_module_id) then
    raise exception 'That pipeline does not belong to that module' using errcode = '23503';
  end if;
  if not exists (select 1 from pipeline_steps s where s.id = p_step_id and s.pipeline_id = p_pipeline_id) then
    raise exception 'That step does not belong to that pipeline' using errcode = '23503';
  end if;

  select rp.pipeline_id into v_old_pipeline from record_pipelines rp where rp.record_id = p_record_id and rp.module_id = p_module_id;
  -- Moving to a DIFFERENT pipeline is "Change pipeline in drawer"; moving
  -- along the one it is on (or first putting it on one) is "Move records
  -- through pipeline stages".
  if v_old_pipeline is not null and v_old_pipeline <> p_pipeline_id then
    perform require_pipeline_change();
  else
    perform require_pipeline_action();
  end if;

  select label into v_step_label from pipeline_steps where id = p_step_id;
  insert into record_pipelines (record_id, module_id, pipeline_id, step_id)
  values (p_record_id, p_module_id, p_pipeline_id, p_step_id)
  on conflict (record_id, module_id) do update
    set pipeline_id = excluded.pipeline_id, step_id = excluded.step_id, updated_at = now();

  if v_old_pipeline is not null and v_old_pipeline <> p_pipeline_id then
    select label into v_old_label from pipelines where id = v_old_pipeline;
    select label into v_new_label from pipelines where id = p_pipeline_id;
    select label into v_module_label from modules where id = p_module_id;
    insert into record_activity (record_id, actor_id, kind, summary, from_value, to_value)
    values (p_record_id, auth.uid(), 'pipeline', 'Pipeline changed in ' || coalesce(v_module_label, 'module'),
            v_old_label, v_new_label || ' — ' || v_step_label);
    -- Spec: "recorded in the record's Updates tab, showing the old pipeline,
    -- the new one, which module it was changed in, who changed it and when".
    insert into updates (record_id, author_id, body)
    values (p_record_id, auth.uid(),
            'Pipeline changed in ' || coalesce(v_module_label, 'this module') || ': ' || coalesce(v_old_label, '—') || ' → ' || v_new_label
            || ', starting at ' || v_step_label || '.');
  else
    insert into record_activity (record_id, actor_id, kind, summary, to_value)
    values (p_record_id, auth.uid(), 'pipeline', 'Pipeline step changed', v_step_label);
  end if;
end;
$$;

create or replace function clear_pipeline(p_record_id uuid, p_module_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_module_edit_on_record(p_record_id, p_module_id);
  perform require_pipeline_change();
  delete from record_pipelines where record_id = p_record_id and module_id = p_module_id;
  insert into record_activity (record_id, actor_id, kind, summary)
  values (p_record_id, auth.uid(), 'pipeline', 'Pipeline removed');
end;
$$;
