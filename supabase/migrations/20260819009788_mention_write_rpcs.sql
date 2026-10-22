-- =============================================================================
-- @Mentions — 3 of 5: writing a mention.
--
--   mention_notify             internal: one notification per recipient who
--                              has not muted the record; a second mention of
--                              the same person on the same update/reply is a
--                              no-op (partial unique indexes, 9786)
--   add_update_with_mentions   rewritten: the mention set is
--                              `mention_candidates(rec, 'updates')`, not the
--                              team roster (admins and visibility-grant
--                              viewers can be mentioned; suspended users and
--                              the author cannot)
--   edit_update_with_mentions  new: diff old vs new — only newly added people
--                              are notified, removed people's notifications
--                              are revoked, the rest are left alone
--   add_case_reply_with_mentions  new
--   mention_field              new: @ on any field, with an optional note and
--                              the previous value if the SENDER changed the
--                              field in the last ten minutes (the window is
--                              decided here, not by the client); never for a
--                              sensitive field; writes no update and no
--                              activity row (the plan: not posted to Updates)
--   delete_update / delete_case_reply / delete_case  revoke the mentions
--                              (soft deletes never fire the FK cascades)
--
-- Nothing else creates mentions — bulk edits, imports and automations go
-- through other functions — so "never create mentions" holds by construction.
-- =============================================================================

create or replace function public.mention_preview(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), 160);
$$;

create or replace function public.mention_notify(
  p_recipients    uuid[],
  p_source_kind   text,
  p_record_id     uuid,
  p_update_id     uuid,
  p_case_id       uuid,
  p_case_reply_id uuid,
  p_field_key     text,
  p_preview       text,
  p_note          text,
  p_current       text,
  p_previous      text
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  if p_recipients is null or cardinality(p_recipients) = 0 then
    return 0;
  end if;
  insert into notifications
    (recipient_id, actor_id, body, record_id, source_kind,
     update_id, case_id, case_reply_id, field_key, preview, note, current_value, previous_value)
  select r, auth.uid(), coalesce(p_preview, ''), p_record_id, p_source_kind,
         p_update_id, p_case_id, p_case_reply_id, p_field_key, p_preview, p_note, p_current, p_previous
    from unnest(p_recipients) as r
   where r <> auth.uid()
     and not exists (select 1 from notification_mutes m where m.user_id = r and m.record_id = p_record_id)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.mention_preview(text) from public, anon;
revoke execute on function public.mention_notify(uuid[], text, uuid, uuid, uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mention_preview(text) to authenticated, service_role;
grant execute on function public.mention_notify(uuid[], text, uuid, uuid, uuid, uuid, text, text, text, text, text) to service_role;

-- ── Updates ──────────────────────────────────────────────────────────────
create or replace function public.add_update_with_mentions(
  p_record_id           uuid,
  p_body                text,
  p_parent_id           uuid,
  p_mentioned_user_ids  uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_update_id uuid;
  v_valid     uuid[];
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
$$;

create or replace function public.edit_update_with_mentions(
  p_update_id           uuid,
  p_body                text,
  p_mentioned_user_ids  uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_author uuid;
  v_old    uuid[];
  v_new    uuid[];
  v_added  uuid[];
  v_gone   uuid[];
begin
  select record_id, author_id into v_record, v_author
    from updates where id = p_update_id and deleted_at is null;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'updates');
  if v_author <> auth.uid() and not auth_is_admin() then
    raise exception 'Only the author or an admin may edit this update' using errcode = '42501';
  end if;

  select coalesce(array_agg(user_id), '{}') into v_old from update_mentions where update_id = p_update_id;
  select coalesce(array_agg(distinct m), '{}') into v_new
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(v_record, 'updates'));

  select coalesce(array_agg(x), '{}') into v_added from unnest(v_new) as x where not (x = any (v_old));
  select coalesce(array_agg(x), '{}') into v_gone  from unnest(v_old) as x where not (x = any (v_new));

  update updates set body = p_body, edited_at = now() where id = p_update_id;

  if cardinality(v_added) > 0 then
    insert into update_mentions (update_id, user_id) select p_update_id, m from unnest(v_added) as m
    on conflict do nothing;
    perform mention_notify(v_added, 'mention_update', v_record, p_update_id, null, null, null,
                           mention_preview(p_body), null, null, null);
  end if;
  if cardinality(v_gone) > 0 then
    delete from update_mentions where update_id = p_update_id and user_id = any (v_gone);
    update notifications set revoked_at = now()
     where update_id = p_update_id and recipient_id = any (v_gone) and revoked_at is null;
  end if;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update edited');
end;
$$;

create or replace function public.delete_update(p_update_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  -- The post's mentions go, and its replies' (a reply is not shown without its post).
  update notifications set revoked_at = now()
   where revoked_at is null
     and (update_id = p_update_id
          or update_id in (select id from updates where parent_id = p_update_id));

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'update', 'Update deleted');
end;
$$;

-- ── Cases ────────────────────────────────────────────────────────────────
create or replace function public.add_case_reply_with_mentions(
  p_case_id             uuid,
  p_body                text,
  p_mentioned_user_ids  uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record   uuid;
  v_number   bigint;
  v_reply_id uuid;
  v_valid    uuid[];
begin
  select record_id, number into v_record, v_number from cases where id = p_case_id and deleted_at is null;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  perform require_tab_edit(v_record, 'cases');

  insert into case_replies (case_id, author_id, body)
  values (p_case_id, auth.uid(), p_body)
  returning id into v_reply_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'case', 'Case reply added');

  select array_agg(distinct m) into v_valid
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(v_record, 'cases'));

  if v_valid is not null then
    insert into case_reply_mentions (case_reply_id, user_id)
    select v_reply_id, m from unnest(v_valid) as m;
    perform mention_notify(v_valid, 'mention_case_reply', v_record, null, p_case_id, v_reply_id, null,
                           mention_preview(format('Case #%s: %s', v_number, p_body)), null, null, null);
  end if;

  return v_reply_id;
end;
$$;

create or replace function public.delete_case_reply(p_reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_body   text;
  v_number bigint;
begin
  select c.record_id, r.body, c.number into v_record, v_body, v_number
    from case_replies r join cases c on c.id = r.case_id
   where r.id = p_reply_id and r.deleted_at is null;
  if v_record is null then
    raise exception 'not found';
  end if;
  if not auth_is_admin() then
    raise exception 'Only an admin may delete a case reply' using errcode = '42501';
  end if;

  update case_replies set deleted_at = now() where id = p_reply_id;
  update notifications set revoked_at = now() where case_reply_id = p_reply_id and revoked_at is null;

  insert into record_activity (record_id, actor_id, kind, summary, from_value)
  values (v_record, auth.uid(), 'case',
          format('Deleted a reply on case #%s', v_number), v_body);
end;
$$;

create or replace function public.delete_case(p_case_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_number bigint;
  v_title  text;
begin
  select record_id, number, title into v_record, v_number, v_title
    from cases where id = p_case_id and deleted_at is null;
  if v_record is null then
    raise exception 'not found';
  end if;
  if not auth_is_admin() then
    raise exception 'Only an admin may delete a case thread' using errcode = '42501';
  end if;

  update cases set deleted_at = now() where id = p_case_id;
  update case_replies set deleted_at = now()
   where case_id = p_case_id and deleted_at is null;
  update notifications set revoked_at = now() where case_id = p_case_id and revoked_at is null;

  insert into record_activity (record_id, actor_id, kind, summary, from_value)
  values (v_record, auth.uid(), 'case',
          format('Deleted case #%s — moved to the Recycle Bin', v_number), v_title);
end;
$$;

-- ── Fields ───────────────────────────────────────────────────────────────
create or replace function public.mention_field(
  p_record_id           uuid,
  p_field_key           text,
  p_mentioned_user_ids  uuid[],
  p_note                text,
  p_include_previous    boolean
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label     text;
  v_sensitive boolean;
  v_valid     uuid[];
  v_current   text;
  v_previous  text;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not record_visible(p_record_id) then
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

  select array_agg(distinct m) into v_valid
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m
   where m = any (mention_candidates(p_record_id, 'field:' || p_field_key));
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

  return mention_notify(v_valid, 'mention_field', p_record_id, null, null, null, p_field_key,
                        mention_preview(v_label || coalesce(' — ' || v_note, '')),
                        v_note, v_current, v_previous);
end;
$$;

-- The sender's own recent change on a field, for the composer's "Include
-- previous value" checkbox: null when there is nothing to include.
create or replace function public.my_recent_field_change(p_record_id uuid, p_field_key text)
returns table (previous_value text, changed_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.from_value, a.at
    from record_activity a
    join fields f on f.key = p_field_key and not f.sensitive
   where record_visible(p_record_id)
     and a.record_id = p_record_id
     and a.kind = 'field'
     and a.field_key = p_field_key
     and a.actor_id = auth.uid()
     and a.at > now() - interval '10 minutes'
   order by a.at desc
   limit 1;
$$;

revoke execute on function public.add_update_with_mentions(uuid, text, uuid, uuid[]) from public, anon;
revoke execute on function public.edit_update_with_mentions(uuid, text, uuid[]) from public, anon;
revoke execute on function public.add_case_reply_with_mentions(uuid, text, uuid[]) from public, anon;
revoke execute on function public.mention_field(uuid, text, uuid[], text, boolean) from public, anon;
revoke execute on function public.my_recent_field_change(uuid, text) from public, anon;
grant execute on function public.add_update_with_mentions(uuid, text, uuid, uuid[]) to authenticated, service_role;
grant execute on function public.edit_update_with_mentions(uuid, text, uuid[]) to authenticated, service_role;
grant execute on function public.add_case_reply_with_mentions(uuid, text, uuid[]) to authenticated, service_role;
grant execute on function public.mention_field(uuid, text, uuid[], text, boolean) to authenticated, service_role;
grant execute on function public.my_recent_field_change(uuid, text) to authenticated, service_role;
