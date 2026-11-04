-- Sending inbox (client, 3 Nov 2026): "I could choose which inbox those emails
-- come out of" — for applications and agreements; office@ for "contracts,
-- agreements and other office type info".
--
-- One row per kind of CRM email. 'own' = the sender's own connected mailbox (as
-- before); 'mailbox' = one company inbox for everyone (office@); 'signwell' =
-- agreements only, SignWell emails the signers itself (as before).
--
-- Sending from a company inbox borrows the connection of whoever connected it,
-- the same rule automations already follow (automation_mail_sender): the inbox
-- is the company's, chosen by an admin, not a person's. The outbox row keeps
-- who asked (requested_by) and what it was for (crm_ref), so a failed send is
-- reported on the record it belongs to.

-- ── the setting ─────────────────────────────────────────────────────────────
create table if not exists mail_send_purposes (
  id          uuid primary key default gen_random_uuid(),
  purpose     text not null unique check (purpose in ('applications', 'proposals', 'agreements')),
  mode        text not null check (mode in ('own', 'mailbox', 'signwell')),
  mailbox_id  uuid references mail_mailboxes(id) on delete cascade,
  updated_by  uuid references profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  check ((mode = 'mailbox') = (mailbox_id is not null)),
  check (mode <> 'signwell' or purpose = 'agreements')
);
alter table mail_send_purposes enable row level security;
alter table mail_send_purposes force row level security;
-- Read and written by the server only (service role); admins change it through set_mail_send_purpose.
revoke all on mail_send_purposes from anon, authenticated;

create or replace function set_mail_send_purpose(p_purpose text, p_mode text, p_mailbox uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_admin_page('presets') then raise exception 'no access to presets' using errcode = '42501'; end if;
  if p_purpose not in ('applications', 'proposals', 'agreements') then raise exception 'unknown email kind' using errcode = '22023'; end if;
  if p_mode not in ('own', 'mailbox', 'signwell') then raise exception 'unknown sending mode' using errcode = '22023'; end if;
  if p_mode = 'signwell' and p_purpose <> 'agreements' then raise exception 'only agreements can be sent by SignWell' using errcode = '22023'; end if;
  if p_mode = 'mailbox' then
    if p_mailbox is null then raise exception 'pick an inbox' using errcode = '22023'; end if;
    if not exists (select 1 from automation_mail_sender(p_mailbox)) then
      raise exception 'That inbox has no working connection. Connect it in Email first.' using errcode = '22023';
    end if;
  end if;
  insert into mail_send_purposes (purpose, mode, mailbox_id, updated_by, updated_at)
  values (p_purpose, p_mode, case when p_mode = 'mailbox' then p_mailbox end, auth.uid(), now())
  on conflict (purpose) do update
     set mode = excluded.mode, mailbox_id = excluded.mailbox_id, updated_by = excluded.updated_by, updated_at = now();
end $$;
revoke execute on function set_mail_send_purpose(text, text, uuid) from public, anon;
grant execute on function set_mail_send_purpose(text, text, uuid) to authenticated;

-- ── the outbox remembers who asked, and for what ────────────────────────────
alter table mail_outbox add column if not exists requested_by uuid references profiles(id) on delete set null;
alter table mail_outbox add column if not exists crm_ref text check (crm_ref is null or char_length(crm_ref) <= 120);

-- A CRM email from a chosen inbox. Server only. The connection used is the
-- preferred person's own when they have one to this inbox, else the inbox's
-- best working connection (automation_mail_sender's order).
create or replace function crm_mail_enqueue(
  p_request      uuid,
  p_mailbox      uuid,
  p_prefer_user  uuid,
  p_requested_by uuid,
  p_crm_ref      text,
  p_record       uuid,
  p_subject      text,
  p_body         text,
  p_to           jsonb,
  p_cc           jsonb,
  p_attachments  jsonb
)
returns table (id uuid, sender_user uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid;
  v_ident uuid;
  v_id    uuid;
  v_n     int;
begin
  select c.user_id, c.identity_id into v_user, v_ident
    from mail_connections c
    join mail_mailboxes m on m.id = c.mailbox_id
   where c.mailbox_id = p_mailbox and c.user_id = p_prefer_user and c.disconnected_at is null
     and c.status in ('ok', 'degraded') and m.deleted_at is null and m.deactivated_at is null
   order by (c.status = 'ok') desc
   limit 1;
  if v_user is null then
    select s.user_id, s.identity_id into v_user, v_ident from automation_mail_sender(p_mailbox) s;
  end if;
  if v_user is null then raise exception 'That inbox has no working connection. Ask an admin to reconnect it in Email.' using errcode = '22023'; end if;
  v_n := jsonb_array_length(coalesce(p_to, '[]')) + jsonb_array_length(coalesce(p_cc, '[]'));
  if v_n = 0 or v_n > 50 then raise exception 'Between 1 and 50 recipients.' using errcode = '22023'; end if;

  insert into mail_outbox (idempotency_key, mailbox_id, user_id, identity_id, kind, subject, body_html, to_recipients,
                           cc_recipients, attachments, status, release_at, record_id, requested_by, crm_ref)
  values (p_request, p_mailbox, v_user, v_ident, 'new', left(p_subject, 255), p_body, coalesce(p_to, '[]'),
          coalesce(p_cc, '[]'), coalesce(p_attachments, '[]'::jsonb), 'held', now(), p_record, p_requested_by, p_crm_ref)
  on conflict (idempotency_key) do update set updated_at = now()
  returning mail_outbox.id into v_id;
  return query select v_id, v_user;
end $$;
revoke execute on function crm_mail_enqueue(uuid, uuid, uuid, uuid, text, uuid, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function crm_mail_enqueue(uuid, uuid, uuid, uuid, text, uuid, text, text, jsonb, jsonb, jsonb) to service_role;

-- ── agreements sent through Outlook ─────────────────────────────────────────
-- 'outlook': SignWell hosts the signing page only; the CRM emails each signer
-- their own link (/sign/<token>) and the reminders, from the chosen inbox.
alter table agreements add column if not exists delivery text not null default 'signwell' check (delivery in ('signwell', 'outlook'));
alter table agreements add column if not exists delivery_mailbox_id uuid references mail_mailboxes(id) on delete set null;
alter table agreements add column if not exists delivery_address text;
alter table agreements add column if not exists delivery_company boolean not null default false;
alter table agreements add column if not exists completion_emailed_at timestamptz;
-- The merchant's name as sent, for the signer's page (which never reads the record).
alter table agreements add column if not exists merchant_name text;
grant select (delivery, delivery_address) on agreements to authenticated;

-- The signer's link: looked up by hash; kept sealed (AES-GCM, server key) so a
-- reminder can carry the same link. Neither is ever granted to the browser.
alter table agreement_signers add column if not exists link_hash bytea;
alter table agreement_signers add column if not exists link_sealed bytea;
alter table agreement_signers add column if not exists link_iv bytea;
alter table agreement_signers add column if not exists link_sent_at timestamptz;
alter table agreement_signers add column if not exists reminders_sent int not null default 0;
alter table agreement_signers add column if not exists last_reminded_at timestamptz;
create unique index if not exists agreement_signers_link_hash on agreement_signers (link_hash) where link_hash is not null;
grant select (link_sent_at, reminders_sent, last_reminded_at) on agreement_signers to authenticated;

-- ── a CRM email that did not go ─────────────────────────────────────────────
-- Called by the sender when Outlook refuses a message for good. An agreement
-- link is a bounce for that signer (delivery failed, sender told, as with
-- SignWell's own bounce); an application or proposal is noted on its record.
create or replace function crm_mail_failed(p_outbox uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o       mail_outbox;
  v_kind  text;
  v_id    uuid;
  s       agreement_signers;
  a       agreements;
  v_to    text;
begin
  select * into o from mail_outbox where id = p_outbox;
  if not found or o.crm_ref is null then return; end if;
  v_kind := split_part(o.crm_ref, ':', 1);
  begin
    v_id := split_part(o.crm_ref, ':', 2)::uuid;
  exception when others then return;
  end;
  v_to := coalesce(o.to_recipients -> 0 ->> 'address', 'the recipient');

  if v_kind in ('agreement_link', 'agreement_reminder') then
    select * into s from agreement_signers where id = v_id;
    if not found then return; end if;
    select * into a from agreements where id = s.agreement_id;
    perform agreement_apply_event(a.vendor, coalesce(a.vendor_document_id, a.id::text), a.id,
                                  'outbox-failed:' || o.id::text, 'document_bounced', now(), null, s.email,
                                  left(coalesce(p_reason, ''), 300), 'housekeeping');
  elsif v_kind = 'application' then
    perform application_log(v_id, o.requested_by, 'Application email to ' || v_to || ' did not send: ' || left(coalesce(p_reason, 'Outlook refused it.'), 200));
  elsif v_kind = 'proposal' then
    perform proposal_log(v_id, o.requested_by, 'Proposal email to ' || v_to || ' did not send: ' || left(coalesce(p_reason, 'Outlook refused it.'), 200));
  end if;
end $$;
revoke execute on function crm_mail_failed(uuid, text) from public, anon, authenticated;
grant execute on function crm_mail_failed(uuid, text) to service_role;
