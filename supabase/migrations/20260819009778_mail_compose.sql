-- =============================================================================
-- The Email module — writing and sending mail.
--
--   mail_drafts               one row per Outlook draft a person is composing
--                             in the CRM. Holds what Outlook generated for a
--                             reply/forward (the quoted history), so every
--                             autosave can put it back under the person's own
--                             words without losing or doubling it.
--   mail_outbox_submit        "Send" / "Schedule send": records the message,
--                             held for the person's undo window or until the
--                             scheduled time. Idempotent per request.
--   mail_claim_outbox         the engine leases due messages (and reclaims a
--                             send that died mid-way once its lease lapses).
--   mail_set_signature        a mailbox's signature, inserted on compose.
--   mail_suggest_recipients   To/Cc/Bcc suggestions from people this person
--                             has actually corresponded with (RLS-bounded).
-- =============================================================================

create table public.mail_drafts (
  id              uuid primary key default gen_random_uuid(),
  mailbox_id      uuid not null references public.mail_mailboxes(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  identity_id     uuid references public.mail_identities(id) on delete set null,
  kind            text not null check (kind in ('new', 'reply', 'replyAll', 'forward')),
  source_graph_id text,
  draft_graph_id  text,
  quote_html      text not null default '' check (char_length(quote_html) <= 2000000),
  saved_at        timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create unique index mail_drafts_graph on public.mail_drafts (mailbox_id, draft_graph_id) where draft_graph_id is not null and deleted_at is null;
create index mail_drafts_user on public.mail_drafts (user_id) where deleted_at is null;

alter table public.mail_drafts enable row level security;
alter table public.mail_drafts force row level security;
revoke insert, update, delete, truncate on public.mail_drafts from anon, authenticated;
revoke all on public.mail_drafts from anon;
create policy mail_drafts_select on public.mail_drafts for select to authenticated
  using (deleted_at is null and user_id = auth.uid());

-- The outbox remembers which draft it sends, so a crashed send resumes.
alter table public.mail_outbox add column if not exists draft_id uuid references public.mail_drafts(id) on delete set null;
create index if not exists mail_outbox_due on public.mail_outbox (release_at) where status in ('held', 'scheduled', 'sending');

-- ── sending ─────────────────────────────────────────────────────────────────
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
     coalesce(p_bcc, '[]'), coalesce(p_attachments, '[]'), v_status, v_release)
  returning o.id, o.release_at, o.status;
end;
$$;

-- Due messages, leased. A 'sending' row whose lease lapsed died mid-send and
-- is picked up again; the sender resumes at the step it reached.
create or replace function public.mail_claim_outbox(p_owner text, p_limit int, p_lease_seconds int, p_only uuid default null)
returns setof public.mail_outbox
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select o.id from public.mail_outbox o
     where (o.status in ('held', 'scheduled') and o.release_at <= now()
            or o.status = 'sending' and o.lease_until < now())
       and (p_only is null or o.id = p_only)
     order by o.release_at
     limit greatest(p_limit, 0)
     for update skip locked
  )
  update public.mail_outbox o
     set status = 'sending', lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
         attempts = o.attempts + 1, updated_at = now()
    from due
   where o.id = due.id
  returning o.*;
$$;

-- ── signatures ──────────────────────────────────────────────────────────────
create or replace function public.mail_set_signature(p_mailbox_id uuid, p_body_html text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
       select 1 from public.mail_connections c
        where c.mailbox_id = p_mailbox_id and c.user_id = auth.uid() and c.disconnected_at is null) then
    raise exception 'not found' using errcode = '42501';
  end if;
  if char_length(coalesce(p_body_html, '')) > 50000 then
    raise exception 'Signatures are limited to 50,000 characters.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_body_html), '') = '' then
    delete from public.mail_signatures where mailbox_id = p_mailbox_id;
    return;
  end if;
  insert into public.mail_signatures (mailbox_id, body_html, source, updated_by_id, updated_at)
  values (p_mailbox_id, p_body_html, 'manual', auth.uid(), now())
  on conflict (mailbox_id) do update
     set body_html = excluded.body_html, source = 'manual', updated_by_id = auth.uid(), updated_at = now();
end;
$$;

-- ── recipient suggestions ───────────────────────────────────────────────────
-- SECURITY INVOKER: only addresses from mail this person can already see.
-- p_q arrives LIKE-escaped from the app.
create or replace function public.mail_suggest_recipients(p_q text, p_limit int default 8)
returns table (address text, name text, hits int)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with people as (
    select lower(m.from_address::text) as address, coalesce(nullif(m.from_name, ''), '') as name
      from public.mail_messages m
     where m.deleted_at is null and m.from_address is not null and m.direction = 'inbound'
       and (m.from_address::text ilike p_q || '%' escape '\' or m.from_name ilike p_q || '%' escape '\'
            or m.from_name ilike '% ' || p_q || '%' escape '\')
    union all
    select lower(r->>'address'), coalesce(r->>'name', '')
      from public.mail_messages m, jsonb_array_elements(m.to_recipients || m.cc_recipients) r
     where m.deleted_at is null and m.direction = 'outbound'
       and ((r->>'address') ilike p_q || '%' escape '\' or (r->>'name') ilike p_q || '%' escape '\'
            or (r->>'name') ilike '% ' || p_q || '%' escape '\')
    union all
    select lower(a), coalesce(c.display_name, '')
      from public.mail_contacts c, unnest(c.addresses) a
     where c.deleted_at is null
       and (a ilike p_q || '%' escape '\' or c.display_name ilike p_q || '%' escape '\'
            or c.display_name ilike '% ' || p_q || '%' escape '\')
  )
  select p.address, max(p.name), count(*)::int
    from people p
   where p.address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
   group by p.address
   order by count(*) desc, p.address
   limit least(greatest(coalesce(p_limit, 8), 1), 20);
$$;

revoke all on function public.mail_outbox_submit(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.mail_outbox_submit(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, timestamptz) to authenticated, service_role;
revoke all on function public.mail_claim_outbox(text, int, int, uuid) from public, anon, authenticated;
grant execute on function public.mail_claim_outbox(text, int, int, uuid) to service_role;
revoke all on function public.mail_set_signature(uuid, text) from public, anon;
grant execute on function public.mail_set_signature(uuid, text) to authenticated, service_role;
revoke all on function public.mail_suggest_recipients(text, int) from public, anon;
grant execute on function public.mail_suggest_recipients(text, int) to authenticated, service_role;
