-- =============================================================================
-- Email module P6c: hardening the send path (review findings).
--
--   * mail_outbox_submit accepted attachment paths as given. Called directly
--     (it is granted to `authenticated`), it could name another person's
--     staged upload — which the engine would then send and delete. Now only
--     paths under the caller's own prefix that really exist in the bucket are
--     accepted, and the stored size replaces the claimed one (35 MB total).
--   * The bucket's own limit drops from 150 MB to 35 MB, so an upload can't
--     exceed what Exchange would send anyway.
--   * mail_outbox gains quote_html (Outlook's quoted history for a reply the
--     ENGINE drafted — a retry must not lose it) and internet_message_id
--     (to tell "sent" from "deleted in Outlook" when the draft disappears).
-- =============================================================================

alter table public.mail_outbox
  add column if not exists quote_html text not null default '' check (char_length(quote_html) <= 2000000),
  add column if not exists internet_message_id text check (internet_message_id is null or char_length(internet_message_id) <= 1000);

update storage.buckets set file_size_limit = 36700160 where id = 'mail-outbox';

create or replace function public.mail_outbox_submit(
  p_request_id      uuid,
  p_mailbox_id      uuid,
  p_draft_id        uuid,
  p_kind            text,
  p_source_graph_id text,
  p_subject         text,
  p_body_html       text,
  p_to              jsonb,
  p_cc              jsonb,
  p_bcc             jsonb,
  p_attachments     jsonb,
  p_send_at         timestamptz
)
returns table (id uuid, release_at timestamptz, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_identity uuid;
  v_undo     smallint;
  v_release  timestamptz;
  v_status   text;
  v_n        int;
  v_att      jsonb;
  v_bad      int;
  v_total    bigint;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;

  -- A replay of the same click returns the first answer.
  return query select o.id, o.release_at, o.status from public.mail_outbox o
                where o.idempotency_key = p_request_id and o.user_id = v_uid;
  if found then return; end if;

  -- Only from a mailbox the person connected themselves: sending AS someone
  -- is never borrowed from another person's sign-in.
  select c.identity_id into v_identity
    from public.mail_connections c
   where c.mailbox_id = p_mailbox_id and c.user_id = v_uid and c.disconnected_at is null
     and c.status in ('ok', 'degraded')
   limit 1;
  if v_identity is null then
    raise exception 'You can only send from a mailbox you connected.' using errcode = '42501';
  end if;
  if p_kind not in ('new', 'reply', 'replyAll', 'forward') then
    raise exception 'Invalid message kind.' using errcode = '22023';
  end if;
  if p_kind <> 'new' and coalesce(p_source_graph_id, '') = '' then
    raise exception 'A reply needs the message it answers.' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(coalesce(p_to, '[]')) + jsonb_array_length(coalesce(p_cc, '[]')) + jsonb_array_length(coalesce(p_bcc, '[]'));
  if v_n = 0 or v_n > 500 then
    raise exception 'Between 1 and 500 recipients.' using errcode = '22023';
  end if;
  if p_draft_id is not null and not exists (select 1 from public.mail_drafts d
                                             where d.id = p_draft_id and d.user_id = v_uid and d.mailbox_id = p_mailbox_id and d.deleted_at is null) then
    raise exception 'That draft is gone.' using errcode = '22023';
  end if;

  -- Attachments: only files this person uploaded (their own prefix), that
  -- really exist in the outbox bucket; the size kept is the stored one, never
  -- the size the browser claimed. 35 MB in all, Exchange's default ceiling.
  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 50 then
    raise exception 'Too many attachments.' using errcode = '22023';
  end if;
  select count(*) filter (where o.name is null
                              or left(a.value->>'path', length(v_uid::text) + 1) <> v_uid::text || '/'
                              or position('..' in a.value->>'path') > 0),
         coalesce(sum((o.metadata->>'size')::bigint), 0),
         coalesce(jsonb_agg(a.value || jsonb_build_object('size', coalesce((o.metadata->>'size')::bigint, 0))) filter (where o.name is not null), '[]'::jsonb)
    into v_bad, v_total, v_att
    from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) a
    left join storage.objects o on o.bucket_id = 'mail-outbox' and o.name = a.value->>'path';
  if v_bad > 0 then
    raise exception 'An attachment is no longer available. Remove it and attach it again.' using errcode = '22023';
  end if;
  if v_total > 35 * 1024 * 1024 then
    raise exception 'Attachments can be up to 35 MB in total.' using errcode = '22023';
  end if;

  if p_send_at is null then
    select coalesce((select s.undo_send_seconds from public.mail_user_settings s where s.user_id = v_uid), 5) into v_undo;
    v_release := now() + make_interval(secs => v_undo);
    v_status := 'held';
  else
    if p_send_at < now() + interval '1 minute' or p_send_at > now() + interval '1 year' then
      raise exception 'Schedule between one minute and one year from now.' using errcode = '22023';
    end if;
    v_release := p_send_at;
    v_status := 'scheduled';
  end if;

  return query
  insert into public.mail_outbox as o
    (idempotency_key, mailbox_id, user_id, identity_id, kind, source_graph_id, draft_id,
     existing_draft_graph_id, subject, body_html, to_recipients, cc_recipients, bcc_recipients,
     attachments, status, release_at)
  values
    (p_request_id, p_mailbox_id, v_uid, v_identity, p_kind, nullif(p_source_graph_id, ''), p_draft_id,
     (select d.draft_graph_id from public.mail_drafts d where d.id = p_draft_id),
     left(coalesce(p_subject, ''), 255), coalesce(p_body_html, ''), coalesce(p_to, '[]'), coalesce(p_cc, '[]'),
     coalesce(p_bcc, '[]'), v_att, v_status, v_release)
  returning o.id, o.release_at, o.status;
end;
$$;

revoke all on function public.mail_outbox_submit(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.mail_outbox_submit(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, timestamptz) to authenticated, service_role;
