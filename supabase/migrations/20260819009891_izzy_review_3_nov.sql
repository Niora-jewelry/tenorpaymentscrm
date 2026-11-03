-- =============================================================================
-- Izzy's review of 3 Nov 2026.
--
-- "Unlocking by hand: user can choose what should unlock." `lift_restrictions`
-- lifts the items chosen, for everyone, and leaves the rest of what that action
-- covered in place. So a lift can now be partial, and Re-lock has to offer what
-- was lifted while the rest of its action is still on.
--
-- "Several files": a File uploaded fire now waits for the uploads to stop. It
-- used to fire on the first file and swallow the next ones, so the conditions were
-- read too early: "Bank statements needs 3, and only if Files Required is empty"
-- saw 1 of 3 on the first file, did not match, and the second and third, swallowed,
-- never asked again. A row in the queue with `not_before` is held; each further
-- file from that person to that row pushes it back.
--
-- "Only admins can delete and restore" a case: restoring answered to the Recycle
-- Bin page, which can be given to anyone. Both now ask the same question.
-- =============================================================================

-- ── choosing what to lift ────────────────────────────────────────────────────

drop function if exists public.viewer_restrictions(uuid);
create function public.viewer_restrictions(rec uuid)
returns table (
  item text, kind text, effect text, automation_name text, applied_at timestamptz,
  can_lift boolean, allow_download boolean, batch_id uuid, batch_items text[], lifted boolean, label text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as u, auth_is_admin() as admin),
  mine as (
    select r.*, m.admin or user_in_group(m.u, r.can_lift) as lifts,
           m.admin or user_in_group(m.u, r.can_lift) or user_in_group(m.u, r.can_see) as sees
      from record_restrictions r cross join me m
     where r.record_id = rec and record_visible(rec)
  ),
  merged as (
    select a.item, a.kind, bool_or(a.lifts) as lifts, bool_or(a.sees) as sees
      from mine a where a.lifted_at is null group by a.item, a.kind
  ),
  shown as (
    select r.*, g.lifts as any_lifts, g.sees as any_sees,
           r.lifted_at is null and r.kind = 'hide' and not g.sees as unseen,
           item_visible(rec, r.item) as may_name
      from mine r left join merged g on g.item = r.item and g.kind = r.kind
  )
  select r.item, r.kind,
         case
           when r.lifted_at is not null then null
           when r.kind = 'hide' and not r.any_sees then 'hide'
           when r.kind = 'lock' and not r.any_lifts then 'lock'
         end,
         case when r.unseen then null else r.automation_name end,
         case when r.unseen then null else r.applied_at end,
         not r.unseen and coalesce(r.any_lifts, r.lifts) and r.lifted_at is null,
         r.allow_download,
         case when r.unseen then null else r.batch_id end,
         case when r.unseen then null else
           (select array_agg(l.label) from (select distinct item_label(x.item) as label from mine x where x.batch_id = r.batch_id and item_visible(rec, x.item)) l where l.label is not null)
         end,
         r.lifted_at is not null,
         case when r.unseen or not r.may_name then null else item_label(r.item) end
    from shown r
   where r.lifted_at is null
      or (r.lifted_by is not null and r.lifts
          and not exists (select 1 from mine n where n.item = r.item and n.kind = r.kind and n.lifted_at is null));
$$;

revoke all on function public.viewer_restrictions(uuid) from public, anon;
grant execute on function public.viewer_restrictions(uuid) to authenticated;

-- The chosen items, each of which this person must be able to lift. Anything else
-- of that kind on those items goes with them: two automations on one item are one
-- lock to lift (spec).
create or replace function public.lift_restrictions(p_record uuid, p_items text[], p_kind text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item  text;
  v_items text[];
begin
  if not record_visible(p_record) then
    raise exception 'You can''t lift this.' using errcode = '42501';
  end if;
  foreach v_item in array p_items loop
    if not restrictions_can_lift(p_record, v_item, p_kind) then
      raise exception 'You can''t lift this.' using errcode = '42501';
    end if;
  end loop;

  with lifted as (
    update record_restrictions set lifted_at = now(), lifted_by = auth.uid()
     where record_id = p_record and kind = p_kind and lifted_at is null and item = any (p_items)
    returning item
  )
  select array_agg(distinct item) into v_items from lifted;
  if v_items is null then return; end if;

  perform restriction_log(p_record, auth.uid(), case p_kind when 'lock' then 'Unlocked' else 'Unhid' end, v_items, null, null);
  perform record_ping(p_record);
end;
$$;

revoke all on function public.lift_restrictions(uuid, text[], text) from public, anon;
grant execute on function public.lift_restrictions(uuid, text[], text) to authenticated;

-- ── File uploaded waits for the uploads to stop ──────────────────────────────

alter table automation_queue add column if not exists not_before timestamptz;

create or replace function public.automation_fire_file(p_row file_rows, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t         automation_triggers;
  v_last    timestamptz;
  v_freq    text;
  v_at      timestamptz := clock_timestamp();
  v_settle  timestamptz := clock_timestamp() + interval '1 minute';
  v_batch   text := p_row.record_id || ':file:' || p_row.id || ':' || p_actor || ':';
begin
  if current_setting('tapdash.automation', true) = 'on' or p_actor is null then return; end if;
  if p_row.kind <> 'application' or not p_row.locked then return; end if;

  for t in
    select * from automation_triggers x
     where x.kind = 'file_uploaded' and (x.match -> 'rows') ? p_row.name
       and (x.only_record is null or x.only_record = p_row.record_id)
       and v_at >= x.active_from
  loop
    -- Still waiting from this person on this row: the same upload, so it waits longer.
    update automation_queue q set not_before = v_settle
     where q.automation_id = t.automation_id and q.done_at is null and q.not_before is not null
       and q.dedupe_key like v_batch || '%';
    continue when found;

    v_freq := coalesce(t.match ->> 'frequency', 'every');
    select fired_at into v_last from automation_file_fires
     where automation_id = t.automation_id and record_id = p_row.record_id and row_name = p_row.name;

    if v_last is not null and v_freq = 'first' then continue; end if;
    if v_last is not null and v_freq = 'first_after_unlock' and (
      exists (select 1 from record_restrictions r where r.automation_id = t.automation_id and r.record_id = p_row.record_id and r.lifted_at is null)
      or not exists (select 1 from record_restrictions r where r.automation_id = t.automation_id and r.record_id = p_row.record_id and r.lifted_at > v_last)
    ) then
      continue;
    end if;

    insert into automation_queue (automation_id, version_id, trigger_id, trigger_kind, record_id, module_id, actor_id, note, occurred_at, dedupe_key, not_before)
    values (t.automation_id, t.version_id, t.trigger_id, t.kind, p_row.record_id, null, p_actor, null, v_at,
            v_batch || floor(extract(epoch from v_at) * 1000)::bigint, v_settle)
    on conflict (automation_id, dedupe_key) do nothing;

    if found then
      insert into automation_file_fires (automation_id, record_id, row_name, fired_at)
      values (t.automation_id, p_row.record_id, p_row.name, v_at)
      on conflict (automation_id, record_id, row_name) do update set fired_at = excluded.fired_at;
    end if;
  end loop;
end;
$$;

revoke all on function public.automation_fire_file(file_rows, uuid) from public, anon, authenticated;

-- The worker leaves a held row until it is due.
do $$
declare
  v_def text := pg_get_functiondef('public.automation_work(integer)'::regprocedure);
  v_old text := 'from automation_queue x where x.done_at is null order by';
begin
  if position(v_old in v_def) = 0 then raise exception 'automation_work: unexpected shape'; end if;
  execute replace(v_def, v_old, 'from automation_queue x where x.done_at is null and (x.not_before is null or x.not_before <= now()) order by');
end $$;

-- ── cases: admins delete and restore ─────────────────────────────────────────

create or replace function public.auth_case_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth_is_admin() or exists (
    select 1 from user_templates ut
      join permission_templates pt on pt.id = ut.template_id
      join profiles p on p.id = ut.user_id
     where ut.user_id = auth.uid() and pt.user_type = 'admin' and p.status = 'active' and p.deleted_at is null
  );
$$;

revoke all on function public.auth_case_admin() from public, anon;
grant execute on function public.auth_case_admin() to authenticated;

do $$
declare
  v_fn  regprocedure;
  v_def text;
begin
  foreach v_fn in array array[
    'public.delete_case(uuid)'::regprocedure, 'public.delete_case_reply(uuid)'::regprocedure,
    'public.restore_case(uuid)'::regprocedure, 'public.restore_case_reply(uuid)'::regprocedure
  ] loop
    v_def := pg_get_functiondef(v_fn);
    if position('auth_is_admin()' in v_def) = 0 and position('auth_admin_page(''recycle_bin'')' in v_def) = 0 then
      raise exception '%: unexpected shape', v_fn;
    end if;
    v_def := replace(v_def, 'auth_admin_page(''recycle_bin'')', 'auth_case_admin()');
    v_def := replace(v_def, 'not auth_is_admin()', 'not auth_case_admin()');
    execute v_def;
  end loop;
end $$;
