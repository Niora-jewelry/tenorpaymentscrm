-- Client UI-UX review, 6 Nov 2026 ("UI-UX Changes to Records-Leads-Deals-Contacts-
-- Tickets"), Updates tab.
--
-- 1. "Move all activity items in CRM to a separate sub tab named activity under the
--    updates tab." `updates.activity` says which is which. It defaults to TRUE, so every
--    writer that logs something (record_log, team_log, automation_log, set_pipeline_step,
--    agreement_log, processor_log and whatever comes next) lands in Activity with no
--    change, and only the writers of what a person wrote say otherwise: the composer and
--    the two field mentions. `is_log` is not reused: it also decides who may read a row
--    (migration 9857), and that must not move.
--
-- 2. "Unable to add files." An Update gets an attachment point the way a case does: an
--    ordinary `file_rows` row, so the five-file cap, the 25MB ceiling, the Recycle Bin and
--    the activity entry all come with it. It answers to the Updates tab, and a file on an
--    Update this viewer may not read is out of reach however they ask for it.

-- ── 1. Activity ──────────────────────────────────────────────────────────
alter table public.updates add column if not exists activity boolean not null default true;

-- What people wrote so far. A log row has a marker, or one of these fixed wordings.
update public.updates u
   set activity = false
 where u.activity
   and not u.is_log
   and u.team_id is null
   and u.automation_id is null
   and (u.parent_id is not null
        or u.field_key is not null
        or exists (select 1 from public.update_mentions m where m.update_id = u.id)
        or not (u.body ~ '^Pipeline changed in '
                or u.body ~ '^Switched off “'
                or u.body ~* 'agreement AGR-[0-9]+'
                or u.body ~ ' application status changed from '));

CREATE OR REPLACE FUNCTION public.add_update_with_mentions(p_record_id uuid, p_body text, p_parent_id uuid, p_mentioned_user_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_update_id uuid;
  v_valid     uuid[];
begin
  if not record_writable(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(p_record_id, 'updates');

  if p_parent_id is not null and not exists (
    select 1 from updates where id = p_parent_id and record_id = p_record_id and parent_id is null
  ) then
    raise exception 'invalid parent update';
  end if;

  insert into updates (record_id, parent_id, author_id, body, activity)
  values (p_record_id, p_parent_id, auth.uid(), p_body, false)
  returning id into v_update_id;

  select array_agg(distinct m) into v_valid
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(p_record_id, 'updates'));

  if v_valid is not null then
    insert into update_mentions (update_id, user_id)
    select v_update_id, m from unnest(v_valid) as m;
    perform mention_notify(v_valid, 'mention_update', p_record_id, v_update_id, null, null, null,
                           mention_preview(p_body), null, null, null);
  end if;

  return v_update_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mention_field(p_record_id uuid, p_field_key text, p_mentioned_user_ids uuid[], p_note text, p_include_previous boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_label     text;
  v_sensitive boolean;
  v_valid     uuid[];
  v_current   text;
  v_previous  text;
  v_update_id uuid;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not record_writable(p_record_id) then
    raise exception 'not found';
  end if;
  select label, sensitive into v_label, v_sensitive
    from fields where key = p_field_key and archived_at is null;
  if v_label is null then
    raise exception 'not found';
  end if;
  if record_field_grant(p_record_id, p_field_key) = 'hidden' then
    raise exception 'not found';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'The note can be up to 500 characters.' using errcode = '22023';
  end if;

  -- Eligible AND not muted: the people who will actually be alerted.
  select array_agg(distinct m) into v_valid
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(p_record_id, 'field:' || p_field_key))
     and not exists (select 1 from notification_mutes mu
                      where mu.user_id = m and mu.record_id = p_record_id);
  if v_valid is null then
    return 0;
  end if;

  if not v_sensitive then
    select values #>> array[p_field_key] into v_current from records where id = p_record_id;
    if coalesce(p_include_previous, false) then
      -- The sender's own change in the last ten minutes, else nothing.
      select from_value into v_previous
        from record_activity
       where record_id = p_record_id
         and kind = 'field'
         and field_key = p_field_key
         and actor_id = auth.uid()
         and at > now() - interval '10 minutes'
       order by at desc
       limit 1;
    end if;
  end if;

  insert into updates (record_id, parent_id, author_id, body, field_key, activity)
  values (p_record_id, null, auth.uid(), coalesce(v_note, 'Mentioned on ' || v_label), p_field_key, false)
  returning id into v_update_id;

  insert into update_mentions (update_id, user_id)
  select v_update_id, m from unnest(v_valid) as m;

  return mention_notify(v_valid, 'mention_field', p_record_id, v_update_id, null, null, p_field_key,
                        mention_preview(v_label || coalesce(' â€” ' || v_note, '')),
                        v_note, v_current, v_previous);
end;
$function$;

-- A member's mention is something a person wrote too.
do $$
declare
  v_def text := pg_get_functiondef('public.mention_field_member(uuid, text, int, text, uuid[], text)'::regprocedure);
begin
  if v_def not like '%field_key, field_member)%' then
    raise exception 'mention_field_member is not what this migration expects';
  end if;
  execute replace(
    replace(v_def, 'body, field_key, field_member)', 'body, field_key, field_member, activity)'),
    $old$'[' || p_index || '].' || p_member_key)$old$,
    $new$'[' || p_index || '].' || p_member_key, false)$new$);
end $$;

-- ── 2. Files on an Update ────────────────────────────────────────────────
alter table public.file_rows
  add column if not exists update_id uuid references public.updates on delete cascade;

alter table public.file_rows drop constraint if exists file_rows_case_anchor;
alter table public.file_rows add constraint file_rows_case_anchor check (
  (kind in ('application', 'other') and case_id is null and case_reply_id is null and field_key is null and update_id is null)
  or (kind = 'case_issue'    and case_id is not null and case_reply_id is null and field_key is null and update_id is null)
  or (kind = 'case_solution' and case_id is not null and case_reply_id is null and field_key is null and update_id is null)
  or (kind = 'case_reply'    and case_id is not null and case_reply_id is not null and field_key is null and update_id is null)
  or (kind = 'field'         and field_key is not null and case_id is null and case_reply_id is null and update_id is null)
  or (kind = 'update_post'   and update_id is not null and case_id is null and case_reply_id is null and field_key is null)
);

create unique index if not exists file_rows_update_one
  on public.file_rows (update_id) where kind = 'update_post' and deleted_at is null;

create or replace function public.file_row_access(p_record uuid, p_kind file_row_kind, p_field_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
           when p_kind::text like 'case%'  then record_tab_grant(p_record, 'cases')
           when p_kind = 'field'           then record_field_grant(p_record, p_field_key)
           when p_kind = 'update_post'     then record_tab_grant(p_record, 'updates')
           else                                 record_tab_grant(p_record, 'files')
         end;
$function$;

-- The storage path carries the kind, so the bucket policy asks the same tab.
create or replace function public.storage_tab_access(rec uuid, kind_segment text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select record_tab_grant(
    rec,
    case kind_segment
      when 'case'        then 'cases'
      when 'statements'  then 'statements'
      when 'update_post' then 'updates'
      else                    'files'
    end
  );
$function$;

-- An Update can be limited to some readers, and the tab grant does not know that. A
-- policy on the row reaches `files` too: its own policies read through file_rows.
drop policy if exists file_rows_update_readable on public.file_rows;
create policy file_rows_update_readable on public.file_rows
  as restrictive for select to authenticated
  using (update_id is null or exists (select 1 from public.updates u where u.id = file_rows.update_id));

-- Get (or make) the attachment point. Only the update's author, or an admin, attaches.
create or replace function public.ensure_update_file_row(p_update_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_record uuid;
  v_author uuid;
  v_row    uuid;
begin
  select u.record_id, u.author_id into v_record, v_author
    from updates u
   where u.id = p_update_id and u.deleted_at is null and not u.activity;
  if v_record is null or not record_writable(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'updates');
  if v_author is distinct from auth.uid() and not auth_is_admin() then
    raise exception 'Only the author of an update can add files to it.' using errcode = '42501';
  end if;

  select id into v_row from file_rows where update_id = p_update_id and kind = 'update_post' and deleted_at is null;
  if v_row is not null then
    return v_row;
  end if;

  insert into file_rows (record_id, kind, name, update_id, locked)
  values (v_record, 'update_post', 'Update attachment', p_update_id, true)
  returning id into v_row;
  return v_row;
end;
$function$;

revoke all on function public.ensure_update_file_row(uuid) from public, anon;
grant execute on function public.ensure_update_file_row(uuid) to authenticated;
