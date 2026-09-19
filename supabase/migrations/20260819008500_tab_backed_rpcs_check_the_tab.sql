-- =============================================================================
-- Part 85: the tab-backed RPCs check the TAB, not just whether you can see the
-- record.
--
-- ── THE HOLE, MEASURED ───────────────────────────────────────────────────
-- Migrations 72/73 put tab grants into the RLS policies on `cases`, `updates`,
-- `files`, `logins`, `statements`, `notes` and the rest. That was correct and
-- it does nothing here: **a SECURITY DEFINER function bypasses RLS**. Every
-- write to those tables goes through one, and all of them asked the same
-- question the record layer used to ask —
--
--   if not record_visible(v_record) then raise exception 'not found'; end if;
--
-- — which is "can I SEE this record", never "may I write THIS TAB of it".
--
-- Run as `demo.rep` (Tickets = View, Logins = Hidden in every module), calling
-- PostgREST directly with their own token. Seven of eight succeeded:
--
--   create_case               on a VIEW-only record   -> 200, case created
--   add_update_with_mentions  on a VIEW-only record   -> 200, update posted
--   set_pipeline_step         on a VIEW-only record   -> 204
--   clear_pipeline            on a VIEW-only record   -> 204
--   statement_file_upload     on a VIEW-only record   -> 200, row created
--   store_login_password      tab HIDDEN              -> 204
--   reveal_password           tab HIDDEN              -> 200  "PWNED"
--
-- The last pair is the serious one. `store_login_password` takes the
-- encryption key from the CALLER, so someone with no access to the Logins tab
-- at all could overwrite a stored credential under a key of their choosing and
-- then read it back through `reveal_password` — write and read of the
-- credential store, through a tab that is not on their screen.
--
-- ── WHAT THIS CHANGES ────────────────────────────────────────────────────
-- Two helpers, and one line added to the top of each function. No other line
-- of any body is touched: the guard is the fix, and mixing it with edits to
-- the logic would make a regression impossible to attribute.
--
-- `record_tab_grant()` already returns Edit for admins (it short-circuits on
-- `auth_is_admin()` inside `record_scope_grant`), so every admin path is
-- unchanged.
--
-- ── WHY CASE ATTACHMENTS ARE CHECKED AGAINST *CASES* ─────────────────────
-- `file_rows` carries both ordinary Files-tab rows and the locked rows that
-- hold a case's issue/solution/reply attachments. They live in the Cases tab,
-- not the Files tab, so gating them on Files would be the wrong tab in both
-- directions — it would block someone who may work the case and admit someone
-- who may only see Files. The tab is chosen from `file_rows.case_id`.
--
-- ── PIPELINES TAKE A MODULE FROM THE BROWSER ─────────────────────────────
-- `set_pipeline_step(p_record_id, p_module_id, ...)` accepted whatever module
-- the caller named. The probe passed the LEADS module id for a TICKETS record
-- and it was written — a `record_pipelines` row for a module the record is not
-- even displayed in, which no screen can show and no code expects.
--
-- Both now require the record to actually be in that module, and the caller to
-- hold Edit on it. That is the rule `lib/records/tabAccess.ts` states in its
-- own header: "Every write action carries a `moduleSlug` from the browser.
-- Trusting it lets a member holding Leads = View and Deals = Edit edit a
-- Leads-only record by saying 'deals'."
-- =============================================================================


create or replace function public.require_tab_edit(rec uuid, p_tab_key text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if record_tab_grant(rec, p_tab_key) <> 'edit' then
    raise exception 'You do not have edit access to this record''s % tab.', p_tab_key
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.require_tab_view(rec uuid, p_tab_key text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if record_tab_grant(rec, p_tab_key) = 'hidden' then
    raise exception 'You do not have access to this record''s % tab.', p_tab_key
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.require_tab_edit(uuid, text) from public, anon;
revoke execute on function public.require_tab_view(uuid, text) from public, anon;
grant execute on function public.require_tab_edit(uuid, text) to authenticated, service_role;
grant execute on function public.require_tab_view(uuid, text) to authenticated, service_role;


-- The module half, for the pipeline bar, which is not a tab.
create or replace function public.require_module_edit_on_record(rec uuid, p_module uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from record_modules rm where rm.record_id = rec and rm.module_id = p_module
  ) then
    -- Same message as a missing record: a caller naming a module this record
    -- is not in learns nothing about which modules it IS in.
    raise exception 'not found';
  end if;

  if not module_editable(p_module) then
    raise exception 'You do not have edit access to that module.'
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.require_module_edit_on_record(uuid, uuid) from public, anon;
grant execute on function public.require_module_edit_on_record(uuid, uuid) to authenticated, service_role;


-- The tab a note belongs to, or null when its scope names neither a tab nor a
-- field. Mirrors `tabIdForScope` in `lib/records/notes.ts` and the CASE in the
-- `notes_all` policy: `scope_id` holds a tab id or a field id, as text.
create or replace function public.note_tab_key(p_note_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case n.scope_kind::text
           when 'tab'   then (select t.key::text from tabs t where t.id::text = n.scope_id)
           when 'field' then (select t.key::text from fields f
                                join tabs t on t.id = f.tab_id
                               where f.id::text = n.scope_id)
         end
    from notes n
   where n.id = p_note_id;
$$;

revoke execute on function public.note_tab_key(uuid) from public, anon;
grant execute on function public.note_tab_key(uuid) to authenticated, service_role;


-- ═══════════════════════════ CASES ═══════════════════════════════════════

create or replace function public.create_case(p_record_id uuid, p_title text, p_issue text, p_manager_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case_id uuid;
  v_managers uuid[];
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(p_record_id, 'cases');

  -- "Ticket managers, always >= 1; issue author auto-assigned."
  v_managers := (select array_agg(distinct m) from unnest(
    array_append(coalesce(p_manager_ids, '{}'), auth.uid())
  ) as m);

  insert into cases (record_id, title, issue, issue_author)
  values (p_record_id, p_title, p_issue, auth.uid())
  returning id into v_case_id;

  insert into case_managers (case_id, user_id)
  select v_case_id, m from unnest(v_managers) as m;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (p_record_id, auth.uid(), 'case', format('Case opened: %s', p_title));

  return v_case_id;
end;
$function$;


create or replace function public.add_case_reply(p_case_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid; v_reply_id uuid;
begin
  select record_id into v_record from cases where id = p_case_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'cases');

  insert into case_replies (case_id, author_id, body)
  values (p_case_id, auth.uid(), p_body)
  returning id into v_reply_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'case', 'Case reply added');

  return v_reply_id;
end;
$function$;


create or replace function public.ensure_case_file_row(p_case_id uuid, p_kind text, p_reply_id uuid default null::uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_record uuid;
  v_number bigint;
  v_row    uuid;
  v_name   text;
begin
  if p_kind not in ('case_issue', 'case_solution', 'case_reply') then
    raise exception 'Not a case attachment point' using errcode = '23514';
  end if;
  if (p_kind = 'case_reply') <> (p_reply_id is not null) then
    raise exception 'A reply attachment needs its reply, and only a reply attachment may have one'
      using errcode = '23514';
  end if;

  select c.record_id, c.number into v_record, v_number
    from cases c where c.id = p_case_id and c.deleted_at is null;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'cases');

  -- A reply id from ANOTHER case would otherwise anchor this row to a thread it
  -- does not belong to, and every read would then disagree with itself.
  if p_reply_id is not null and not exists (
    select 1 from case_replies r where r.id = p_reply_id and r.case_id = p_case_id
  ) then
    raise exception 'That reply is not part of this case' using errcode = '23503';
  end if;

  select id into v_row
    from file_rows
   where case_id = p_case_id
     and kind = p_kind::file_row_kind
     and coalesce(case_reply_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(p_reply_id,  '00000000-0000-0000-0000-000000000000'::uuid)
     and deleted_at is null;
  if v_row is not null then
    return v_row;
  end if;

  -- The name is what the Recycle Bin and the activity log will show, so it says
  -- where the file was rather than repeating the file's own name.
  v_name := case p_kind
              when 'case_issue'    then format('Case #%s — Issue', v_number)
              when 'case_solution' then format('Case #%s — Solution', v_number)
              else                      format('Case #%s — reply', v_number)
            end;

  insert into file_rows (record_id, kind, name, locked, position, case_id, case_reply_id)
  values (v_record, p_kind::file_row_kind, v_name, true, 0, p_case_id, p_reply_id)
  returning id into v_row;

  return v_row;
end;
$function$;


-- ═══════════════════════════ UPDATES ═════════════════════════════════════

create or replace function public.add_update_with_mentions(p_record_id uuid, p_body text, p_parent_id uuid, p_mentioned_user_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_update_id      uuid;
  v_valid_mentions uuid[];
  v_mentioned      uuid;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(p_record_id, 'updates');

  if p_parent_id is not null and not exists (
    select 1 from updates where id = p_parent_id and record_id = p_record_id and parent_id is null
  ) then
    raise exception 'invalid parent update';
  end if;

  insert into updates (record_id, parent_id, author_id, body)
  values (p_record_id, p_parent_id, auth.uid(), p_body)
  returning id into v_update_id;

  select array_agg(distinct m.user_id) into v_valid_mentions
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m(user_id)
    join record_team_members rtm on rtm.record_id = p_record_id and rtm.user_id = m.user_id;

  if v_valid_mentions is not null then
    insert into update_mentions (update_id, user_id)
    select v_update_id, m from unnest(v_valid_mentions) as m;

    foreach v_mentioned in array v_valid_mentions loop
      if v_mentioned <> auth.uid() then
        perform notify(v_mentioned, 'mentioned you in an update', p_record_id, 'update');
      end if;
    end loop;
  end if;

  return v_update_id;
end;
$function$;


create or replace function public.edit_update(p_update_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid; v_author uuid;
begin
  select record_id, author_id into v_record, v_author from updates where id = p_update_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'updates');
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may edit this update' using errcode = '42501';
  end if;

  update updates set body = p_body, edited_at = now() where id = p_update_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update edited');
end;
$function$;


create or replace function public.delete_update(p_update_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid; v_author uuid;
begin
  select record_id, author_id into v_record, v_author from updates where id = p_update_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'updates');
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may delete this update' using errcode = '42501';
  end if;

  update updates set deleted_at = now() where id = p_update_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update deleted');
end;
$function$;


-- ═══════════════════════════ FILES ═══════════════════════════════════════

create or replace function public.record_file_upload(p_file_row_id uuid, p_storage_path text, p_name text, p_size_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid; v_file_id uuid; v_tab text;
begin
  -- A case attachment row belongs to the Cases tab, not the Files tab.
  select fr.record_id, case when fr.case_id is not null then 'cases' else 'files' end
    into v_record, v_tab
    from file_rows fr where fr.id = p_file_row_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, v_tab);

  insert into files (file_row_id, storage_path, name, size_bytes, uploaded_by)
  values (p_file_row_id, p_storage_path, p_name, p_size_bytes, auth.uid())
  returning id into v_file_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'file', format('Uploaded %s', p_name));

  return v_file_id;
end;
$function$;


create or replace function public.delete_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid; v_name text; v_tab text;
begin
  select fr.record_id, f.name, case when fr.case_id is not null then 'cases' else 'files' end
    into v_record, v_name, v_tab
    from files f join file_rows fr on fr.id = f.file_row_id
   where f.id = p_file_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, v_tab);

  update files set deleted_at = now() where id = p_file_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'file', format('Deleted %s', v_name));
end;
$function$;


-- ═══════════════════════════ STATEMENTS ══════════════════════════════════

create or replace function public.statement_file_upload(p_record_id uuid, p_period_id uuid, p_storage_path text, p_name text, p_size_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_file_id uuid; v_period text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(p_record_id, 'statements');

  if not exists (select 1 from statement_periods where id = p_period_id) then
    raise exception 'unknown period';
  end if;

  insert into statement_files (record_id, period_id, storage_path, name, size_bytes, uploaded_by)
  values (p_record_id, p_period_id, p_storage_path, p_name, p_size_bytes, auth.uid())
  returning id into v_file_id;

  select to_char(make_date(year, month, 1), 'Mon YYYY') into v_period
    from statement_periods where id = p_period_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (p_record_id, auth.uid(), 'file', format('Uploaded %s to %s statements', p_name, v_period));

  return v_file_id;
end;
$function$;


create or replace function public.delete_statement_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid; v_name text;
begin
  select record_id, name into v_record, v_name from statement_files where id = p_file_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'statements');

  update statement_files set deleted_at = now() where id = p_file_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'file', format('Deleted %s from statements', v_name));
end;
$function$;


-- ═══════════════════════════ LOGINS ══════════════════════════════════════
-- The pair that mattered most. Storing needs Edit; revealing needs the tab to
-- be visible at all, matching `requireTabEdit`/`requireTabView` in the app.

create or replace function public.store_login_password(p_login_id uuid, p_plaintext text, p_key text, p_key_version text default 'v1'::text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid;
begin
  select record_id into v_record from logins where id = p_login_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'logins');

  update logins
     set password_enc = extensions.pgp_sym_encrypt(p_plaintext, p_key),
         password_key = p_key_version
   where id = p_login_id;
end;
$function$;


create or replace function public.reveal_password(p_login_id uuid, p_key text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_record uuid;
  v_enc    bytea;
  v_type   text;
begin
  select record_id, password_enc, login_type into v_record, v_enc, v_type
    from logins where id = p_login_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  -- Before the audit rows are written: a refused attempt must not leave a
  -- "revealed the password" entry in the record's history.
  perform require_tab_view(v_record, 'logins');

  insert into credential_reveals (login_id, user_id) values (p_login_id, auth.uid());
  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'credential', format('Revealed the %s password', v_type));

  return extensions.pgp_sym_decrypt(v_enc, p_key);
end;
$function$;


-- ═══════════════════════════ PIPELINES ═══════════════════════════════════

create or replace function public.set_pipeline_step(p_record_id uuid, p_module_id uuid, p_pipeline_id uuid, p_step_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_step_label text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_module_edit_on_record(p_record_id, p_module_id);

  -- The pipeline must belong to the module being written, or a record could be
  -- parked on the Lead Pipeline inside Deals.
  if not exists (
    select 1 from pipelines p where p.id = p_pipeline_id and p.module_id = p_module_id
  ) then
    raise exception 'That pipeline does not belong to that module' using errcode = '23503';
  end if;
  if not exists (
    select 1 from pipeline_steps s where s.id = p_step_id and s.pipeline_id = p_pipeline_id
  ) then
    raise exception 'That step does not belong to that pipeline' using errcode = '23503';
  end if;

  select label into v_step_label from pipeline_steps where id = p_step_id;

  insert into record_pipelines (record_id, module_id, pipeline_id, step_id)
  values (p_record_id, p_module_id, p_pipeline_id, p_step_id)
  on conflict (record_id, module_id) do update
    set pipeline_id = excluded.pipeline_id, step_id = excluded.step_id, updated_at = now();

  insert into record_activity (record_id, actor_id, kind, summary, to_value)
  values (p_record_id, auth.uid(), 'pipeline', 'Pipeline step changed', v_step_label);
end;
$function$;


create or replace function public.clear_pipeline(p_record_id uuid, p_module_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_module_edit_on_record(p_record_id, p_module_id);

  delete from record_pipelines where record_id = p_record_id and module_id = p_module_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (p_record_id, auth.uid(), 'pipeline', 'Pipeline removed');
end;
$function$;


-- ═══════════════════════════ NOTES ═══════════════════════════════════════
-- `notes_all` already carries the tab check, and these two bypass it by being
-- SECURITY DEFINER. Edit is the bar the app sets (`requireNoteEdit`), and a
-- scope that resolves to no tab falls back to the module ceiling, exactly as
-- `lib/records/notes.ts` does.

create or replace function public.edit_note(p_note_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid; v_author uuid; v_old text; v_tab text;
begin
  select record_id, author_id, body into v_record, v_author, v_old from notes where id = p_note_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  v_tab := note_tab_key(p_note_id);
  if v_tab is not null then
    perform require_tab_edit(v_record, v_tab);
  elsif not record_module_editable(v_record) then
    raise exception 'You do not have edit access to this record.' using errcode = '42501';
  end if;

  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may edit this note' using errcode = '42501';
  end if;

  update notes set body = p_body, edited_at = now() where id = p_note_id;

  -- Names the case the requirement exists for: an admin rewriting somebody
  -- else's note. The author's own edit is logged too, so the trail is complete
  -- rather than only recording the suspicious half.
  perform log_activity(
    v_record, 'note',
    case when v_author <> auth.uid()
         then 'Edited another user''s note'
         else 'Edited their own note' end,
    null, v_old, p_body);
end;
$function$;


create or replace function public.delete_note(p_note_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_record uuid; v_author uuid; v_old text; v_tab text;
begin
  select record_id, author_id, body into v_record, v_author, v_old from notes where id = p_note_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  v_tab := note_tab_key(p_note_id);
  if v_tab is not null then
    perform require_tab_edit(v_record, v_tab);
  elsif not record_module_editable(v_record) then
    raise exception 'You do not have edit access to this record.' using errcode = '42501';
  end if;

  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may delete this note' using errcode = '42501';
  end if;

  update notes set deleted_at = now() where id = p_note_id;

  perform log_activity(
    v_record, 'note',
    case when v_author <> auth.uid()
         then 'Deleted another user''s note'
         else 'Deleted their own note' end,
    null, v_old, null);
end;
$function$;
