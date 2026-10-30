-- =============================================================================
-- Agreements: the functions. Every status change goes through
-- agreement_apply_event, which is idempotent (a dedupe key per vendor event)
-- and monotonic (a status never steps backwards; a terminal status absorbs
-- everything after it). It writes the activity entry, the Updates post and
-- the sender's notification in the same transaction as the status.
-- =============================================================================

create or replace function agreement_label(n bigint)
returns text language sql immutable as $$ select 'AGR-' || lpad(n::text, 6, '0'); $$;

create or replace function agreement_status_rank(s agreement_status)
returns int language sql immutable as $$
  select case s when 'sending' then 0 when 'sent' then 10 when 'viewed' then 20 when 'partially_signed' then 30 else 100 end;
$$;
create or replace function agreement_signer_rank(s agreement_signer_status)
returns int language sql immutable as $$
  select case s when 'sent' then 10 when 'viewed' then 20 when 'signed' then 30 else 100 end;
$$;

-- ── one writer for the agreement's history ────────────────────────────────────
-- An activity row (the field-history reader shows it) and, when asked, an
-- Updates post authored by the sender (updates.author_id is NOT NULL; a
-- purged sender falls back to the record's creator, then an admin).
create or replace function agreement_log(p_agreement uuid, p_actor uuid, p_summary text, p_update_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a      agreements%rowtype;
  v_auth uuid;
begin
  select * into a from agreements where id = p_agreement;
  if not found then raise exception 'agreement not found' using errcode = 'P0002'; end if;

  insert into record_activity (record_id, actor_id, kind, summary, source)
  values (a.record_id, p_actor, 'agreement', p_summary, 'Agreement ' || agreement_label(a.number));

  if p_update_body is not null then
    v_auth := coalesce(
      p_actor,
      (select id from profiles where id = a.sent_by and deleted_at is null),
      (select r.creator_user_id from records r join profiles p on p.id = r.creator_user_id where r.id = a.record_id and p.deleted_at is null),
      (select p.id from profiles p join roles r on r.id = p.role_id where r.is_admin and p.deleted_at is null and p.status = 'active' order by p.created_at limit 1));
    if v_auth is not null then
      insert into updates (record_id, author_id, body) values (a.record_id, v_auth, p_update_body);
    end if;
  end if;
end $$;
revoke execute on function agreement_log(uuid, uuid, text, text) from public, anon, authenticated;

-- ── the sender's notification ─────────────────────────────────────────────────
-- Spec §8: the sender only; every admin when the sender is gone.
create or replace function agreement_notify(p_agreement uuid, p_body text, p_preview text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a    agreements%rowtype;
  n    int := 0;
  r    uuid;
begin
  select * into a from agreements where id = p_agreement;
  if not found then return 0; end if;
  for r in
    select p.id from profiles p
     where p.id = a.sent_by and p.deleted_at is null and p.status = 'active'
    union
    select p.id from profiles p join roles ro on ro.id = p.role_id
     where ro.is_admin and p.deleted_at is null and p.status = 'active'
       and not exists (select 1 from profiles s where s.id = a.sent_by and s.deleted_at is null and s.status = 'active')
  loop
    if exists (select 1 from notification_mutes m where m.user_id = r and m.record_id = a.record_id) then continue; end if;
    insert into notifications (recipient_id, actor_id, body, record_id, source_kind, agreement_id, preview)
    values (r, null, p_body, a.record_id, 'agreement', a.id, p_preview);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function agreement_notify(uuid, text, text) from public, anon, authenticated;

-- ── apply one vendor event ────────────────────────────────────────────────────
create or replace function agreement_apply_event(
  p_vendor             text,
  p_vendor_document_id text,
  p_agreement_hint     uuid,
  p_dedupe_key         text,
  p_event_type         text,
  p_event_time         timestamptz,
  p_event_hash         text,
  p_signer_email       text,
  p_reason             text,
  p_source             text
)
returns table (applied boolean, agreement_id uuid, record_id uuid, status_before agreement_status, status_after agreement_status, completed_now boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a        agreements%rowtype;
  s        agreement_signers%rowtype;
  v_target agreement_status;
  v_signer agreement_signer_status;
  v_label  text;
  v_name   text;
  v_now    timestamptz := coalesce(p_event_time, now());
  v_done   boolean := false;
  v_terminal boolean;
begin
  select * into a from agreements
   where (vendor = p_vendor and vendor_document_id = p_vendor_document_id)
      or (p_agreement_hint is not null and id = p_agreement_hint)
   order by (vendor_document_id = p_vendor_document_id) desc
   limit 1
   for update;
  if not found then raise exception 'unknown document' using errcode = 'P0002'; end if;

  insert into agreement_events (agreement_id, vendor, vendor_document_id, event_type, event_time, event_hash, dedupe_key, signer_email, source)
  values (a.id, p_vendor, p_vendor_document_id, p_event_type, v_now, p_event_hash, p_dedupe_key, p_signer_email, p_source)
  on conflict (dedupe_key) do nothing;
  if not found then
    return query select false, a.id, a.record_id, a.status, a.status, false;
    return;
  end if;

  v_label := agreement_label(a.number);
  v_terminal := agreement_status_rank(a.status) >= 100;

  -- The signer the event is about, when it names one.
  if p_signer_email is not null then
    select * into s from agreement_signers where agreement_signers.agreement_id = a.id and lower(email) = lower(p_signer_email) order by slot limit 1 for update;
  end if;
  v_name := coalesce(s.name, p_signer_email);

  v_target := case p_event_type
    when 'document_sent' then 'sent'
    when 'document_viewed' then 'viewed'
    when 'document_signed' then 'partially_signed'
    when 'document_completed' then 'completed'
    when 'document_declined' then 'declined'
    when 'document_expired' then 'expired'
    when 'housekeeping_expired' then 'expired'
    when 'document_canceled' then 'voided'
    when 'user_voided' then 'voided'
    else null end;
  v_signer := case p_event_type
    when 'document_viewed' then 'viewed'
    when 'document_signed' then 'signed'
    when 'document_declined' then 'declined'
    when 'document_bounced' then 'bounced'
    else null end;

  -- Per-signer status first: it moves independently of the document's —
  -- but nothing moves once the agreement is closed.
  if not v_terminal and s.id is not null and v_signer is not null and agreement_signer_rank(v_signer) > agreement_signer_rank(s.status) then
    update agreement_signers set status = v_signer,
           viewed_at = case when v_signer = 'viewed' then coalesce(viewed_at, v_now) else viewed_at end,
           signed_at = case when v_signer = 'signed' then coalesce(signed_at, v_now) else signed_at end,
           declined_at = case when v_signer = 'declined' then coalesce(declined_at, v_now) else declined_at end,
           decline_reason = case when v_signer = 'declined' then p_reason else decline_reason end,
           bounced_at = case when v_signer = 'bounced' then coalesce(bounced_at, v_now) else bounced_at end
     where id = s.id;
    v_done := true;
    begin
      if v_signer = 'viewed' then
        perform agreement_log(a.id, null, v_name || ' viewed ' || v_label, v_name || ' viewed agreement ' || v_label || '.');
        perform agreement_notify(a.id, v_name || ' viewed agreement ' || v_label || '.', null);
      elsif v_signer = 'signed' then
        perform agreement_log(a.id, null, v_name || ' signed ' || v_label, v_name || ' signed agreement ' || v_label || '.');
        perform agreement_notify(a.id, v_name || ' signed agreement ' || v_label || '.', null);
      elsif v_signer = 'bounced' then
        -- Spec (30 Oct): the other signers continue; the user fixes the
        -- address and resends to this one signer only.
        perform agreement_log(a.id, null, 'Email to ' || v_name || ' bounced for ' || v_label, 'The email to ' || v_name || ' (' || s.email || ') for agreement ' || v_label || ' bounced. Fix the address in Ownership and resend to them.');
        perform agreement_notify(a.id, 'The email to ' || v_name || ' for agreement ' || v_label || ' bounced. Fix the address and resend to them.', s.email);
      end if;
    end;
  elsif p_event_type = 'document_bounced' and s.id is null and not v_terminal then
    perform agreement_log(a.id, null, 'An email bounced for ' || v_label, 'An email for agreement ' || v_label || ' bounced (' || coalesce(p_signer_email, 'unknown address') || ').');
    perform agreement_notify(a.id, 'An email for agreement ' || v_label || ' bounced. Check the signers'' addresses.', null);
    v_done := true;
  end if;

  -- The document's status: forward only, terminal absorbs.
  if v_target is not null and not v_terminal and agreement_status_rank(v_target) > agreement_status_rank(a.status) then
    update agreements set status = v_target, last_event_at = v_now,
           completed_at = case when v_target = 'completed' then v_now else completed_at end,
           declined_at = case when v_target = 'declined' then v_now else declined_at end,
           decline_reason = case when v_target = 'declined' then p_reason else decline_reason end,
           expired_at = case when v_target = 'expired' then v_now else expired_at end,
           voided_at = case when v_target = 'voided' then coalesce(voided_at, v_now) else voided_at end,
           download_status = case when v_target = 'completed' then 'pending' else download_status end,
           next_attempt_at = case when v_target = 'completed' then now() else next_attempt_at end,
           download_attempts = case when v_target = 'completed' then 0 else download_attempts end
     where id = a.id;
    v_done := true;
    if v_target = 'completed' then
      update agreement_signers set status = 'signed', signed_at = coalesce(signed_at, v_now) where agreement_signers.agreement_id = a.id and status <> 'signed';
      perform agreement_log(a.id, null, v_label || ' completed — every principal signed', 'Agreement ' || v_label || ' is complete: every principal has signed. The signed PDF is being saved to this record.');
      perform agreement_notify(a.id, 'All principals signed agreement ' || v_label || '. The signed PDF is saved on the record.', null);
    elsif v_target = 'declined' then
      perform agreement_log(a.id, null, v_label || ' declined by ' || coalesce(v_name, 'a signer'), 'Agreement ' || v_label || ' was declined by ' || coalesce(v_name, 'a signer') || coalesce(': ' || nullif(p_reason, ''), '') || '.');
      perform agreement_notify(a.id, coalesce(v_name, 'A signer') || ' declined agreement ' || v_label || coalesce(': ' || nullif(p_reason, ''), '') || '.', null);
    elsif v_target = 'expired' then
      perform agreement_log(a.id, null, v_label || ' expired', 'Agreement ' || v_label || ' expired before every principal signed.');
      perform agreement_notify(a.id, 'Agreement ' || v_label || ' expired before every principal signed.', null);
    elsif v_target = 'voided' then
      perform agreement_log(a.id, null, v_label || ' voided', 'Agreement ' || v_label || ' was voided.');
    elsif v_target = 'viewed' and s.id is null then
      perform agreement_log(a.id, null, v_label || ' viewed', null);
    end if;
  end if;

  update agreement_events set applied = v_done where dedupe_key = p_dedupe_key;
  select * into a from agreements where id = a.id;
  return query select v_done, a.id, a.record_id, a.status, a.status, (v_done and v_target = 'completed');
end $$;
revoke execute on function agreement_apply_event(text, text, uuid, text, text, timestamptz, text, text, text, text) from public, anon, authenticated;

-- A download attempt claims rows due now and leases them for five minutes.
create or replace function agreement_claim_downloads(p_limit int)
returns setof agreements
language sql
security definer
set search_path = public, pg_temp
as $$
  update agreements a
     set next_attempt_at = now() + interval '5 minutes'
   where a.id in (
     select id from agreements
      where download_status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at limit greatest(1, p_limit)
      for update skip locked)
  returning a.*;
$$;
revoke execute on function agreement_claim_downloads(int) from public, anon, authenticated;

-- Spec §8: on day 30 the agreement expires.
create or replace function agreement_expire_stale()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r record; n int := 0;
begin
  for r in select id, vendor, vendor_document_id from agreements
            where status in ('sent', 'viewed', 'partially_signed') and expires_at < now()
  loop
    perform agreement_apply_event(r.vendor, coalesce(r.vendor_document_id, r.id::text), r.id, 'expire:' || r.id::text,
                                  'housekeeping_expired', now(), null, null, null, 'housekeeping');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function agreement_expire_stale() from public, anon, authenticated;

-- ── settings (Admin › Presets) ────────────────────────────────────────────────
create or replace function set_agreement_settings(
  p_expires_days int, p_reminders boolean, p_requester_name text, p_requester_email text, p_subject text, p_message text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_admin_page('presets') then raise exception 'no access to presets' using errcode = '42501'; end if;
  if p_expires_days is null or p_expires_days < 1 or p_expires_days > 365 then raise exception 'expiry must be 1–365 days' using errcode = '23514'; end if;
  if btrim(coalesce(p_requester_name, '')) = '' then raise exception 'the sender name cannot be empty' using errcode = '23514'; end if;
  if btrim(coalesce(p_subject, '')) = '' or btrim(coalesce(p_message, '')) = '' then raise exception 'subject and message cannot be empty' using errcode = '23514'; end if;
  update agreement_settings
     set expires_days = p_expires_days, reminders = coalesce(p_reminders, true),
         requester_name = btrim(p_requester_name), requester_email = nullif(btrim(coalesce(p_requester_email, '')), ''),
         email_subject = btrim(p_subject), email_message = p_message,
         updated_by = auth.uid(), updated_at = now()
   where singleton;
end $$;
revoke execute on function set_agreement_settings(int, boolean, text, text, text, text) from public, anon;
grant execute on function set_agreement_settings(int, boolean, text, text, text, text) to authenticated;

-- ── notifications: the new kind ───────────────────────────────────────────────
create or replace function public.notification_visible(n public.notifications)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.revoked_at is null
     and (
       (n.source_kind not like 'mention\_%' and n.source_kind <> 'agreement')
       or (n.source_kind = 'agreement' and record_visible(n.record_id) and tab_visible(n.record_id, agreements_tab_key()))
       or (
         n.source_kind like 'mention\_%'
         and record_visible(n.record_id)
         and case n.source_kind
               when 'mention_update' then
                 tab_visible(n.record_id, 'updates')
                 and exists (select 1 from updates u
                              where u.id = n.update_id and u.deleted_at is null
                                and (u.parent_id is null or exists (select 1 from updates p where p.id = u.parent_id and p.deleted_at is null)))
               when 'mention_case_reply' then
                 tab_visible(n.record_id, 'cases')
                 and exists (select 1 from case_replies r join cases c on c.id = r.case_id
                              where r.id = n.case_reply_id and r.deleted_at is null and c.deleted_at is null)
               when 'mention_field' then
                 record_field_grant(n.record_id, n.field_key::text) <> 'hidden'
                 and exists (select 1 from fields f where f.key = n.field_key and f.archived_at is null)
               else false
             end
       )
     );
$$;

create or replace function public.notification_rows(p_ids uuid[])
returns setof public.notification_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.id, n.source_kind, n.record_id, r.deal_name, n.actor_id, a.full_name,
         n.update_id, u.parent_id, n.case_id, c.number, n.case_reply_id,
         n.field_key::text, f.label,
         case n.source_kind
           when 'mention_update' then 'updates'
           when 'mention_case_reply' then 'cases'
           when 'mention_field' then t.key::text
           when 'agreement' then agreements_tab_key()
           else null end,
         case when n.source_kind = 'mention_field' then s.key::text else null end,
         n.body, n.preview, n.note, n.current_value, n.previous_value,
         n.created_at, n.read_at, n.opened_at
    from notifications n
    left join records r on r.id = n.record_id
    left join profiles a on a.id = n.actor_id
    left join updates u on u.id = n.update_id
    left join cases c on c.id = n.case_id
    left join fields f on f.key = n.field_key
    left join tabs t on t.id = f.tab_id
    left join subtabs s on s.id = f.subtab_id
   where n.id = any (p_ids)
     and n.recipient_id = auth.uid()
     and notification_visible(n);
$$;

-- Agreement notifications count with the mentions in the sidebar badge.
create or replace function public.my_unread_counts()
returns table (mentions int, phone int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    count(*) filter (where n.source_kind like 'mention\_%' or n.source_kind = 'agreement')::int,
    count(*) filter (where n.source_kind in ('call', 'voicemail', 'recording', 'sms'))::int
    from notifications n
   where n.recipient_id = auth.uid()
     and n.read_at is null
     and n.created_at >= now() - interval '90 days'
     and notification_visible(n);
$$;
