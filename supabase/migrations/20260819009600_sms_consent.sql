-- ============================================================================
-- SMS consent — who agreed to be texted, when, and how.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
-- US carriers require a business to register before they will deliver text
-- messages, and TapDash's registration was REJECTED on three grounds, the
-- first of which was that the opt-in could not be verified. The filing
-- described a consent checkbox on tapdash.co that does not exist.
--
-- A screenshot of a form is weak evidence. A dated record per person, carrying
-- the exact words they agreed to, is the thing that answers "when did this
-- merchant consent?" months later, when a complaint arrives and nobody
-- remembers.
--
-- ── THE CONSENT TEXT IS SNAPSHOTTED, NOT REFERENCED ─────────────────────────
-- `consent_text` stores the wording shown AT THE MOMENT OF AGREEMENT, in full,
-- rather than a version number or a foreign key to a terms table.
--
-- This is the whole point of the table. Wording changes — ours will, because
-- the carriers just rejected the current one. A record saying "agreed to terms
-- v2" is worthless once v2 has been edited, and worse than worthless if it
-- silently now points at wording the person never saw. Storing the text makes
-- the row self-contained and true forever, at the cost of some repetition.
--
-- ── CONSENT IS NOT DELETED, IT IS REVOKED ───────────────────────────────────
-- Replying STOP does not erase the fact that someone once agreed; it ends the
-- permission from that moment. Both facts matter and both are kept:
-- `revoked_at` closes the permission while the original consent stays readable.
-- A deleted row would make an opt-out indistinguishable from someone who never
-- opted in, and those carry different obligations.
-- ============================================================================

create type sms_consent_source as enum (
  -- Ticked the box on the public consent page.
  'web_form',
  -- Told a representative on a call. The rep records it and is named in
  -- `recorded_by_id`; the script they read is snapshotted in `consent_text`.
  'verbal',
  -- Signed paperwork carrying the SMS clause.
  'paperwork',
  -- Imported from a prior system, where the original evidence lives elsewhere.
  'imported'
);

create table if not exists public.sms_consents (
  id              uuid primary key default gen_random_uuid(),

  -- E.164, always. Matching a consent to an outgoing text is an exact string
  -- comparison, exactly as `resolve_record_by_phone` is, and a number stored
  -- as "(732) 724-1779" is a consent nothing will ever find.
  e164            text not null check (e164 ~ '^\+[1-9][0-9]{6,14}$'),

  full_name       text,
  business_name   text,
  email           text,

  source          sms_consent_source not null,

  -- The words they actually agreed to. See the header: this is snapshotted
  -- deliberately and must never become a reference.
  consent_text    text not null check (length(btrim(consent_text)) > 0),

  /*
   * Evidence of the act itself. IP and user agent are meaningful only for the
   * web form and are null otherwise — an absence that says "this was not a
   * web submission" without needing a separate flag.
   */
  ip              inet,
  user_agent      text,

  -- Who wrote the row down. NULL for the public form, where there is no
  -- signed-in user; set for verbal and paperwork, where a person vouched.
  recorded_by_id  uuid references public.profiles(id) on delete set null,

  -- Free text for "signed application dated 12 March", or the ticket number a
  -- verbal consent was logged against.
  note            text,

  created_at      timestamptz not null default now(),

  -- Revocation. Set when STOP arrives or an admin withdraws it.
  revoked_at      timestamptz,
  revoked_reason  text,

  /*
   * A representative cannot record consent they did not witness. The web form
   * has no actor by definition; everything else must name one, or the record
   * asserts that somebody agreed with nobody responsible for saying so.
   */
  constraint sms_consents_actor_shape check (
    (source = 'web_form' and recorded_by_id is null)
    or (source <> 'web_form')
  )
);

/*
 * One LIVE consent per number. A second while the first stands would make
 * "is this number consented?" a question with two answers, and the partial
 * index lets a revoked consent sit alongside a fresh one — which is the real
 * sequence when someone opts out and later opts back in.
 */
create unique index if not exists sms_consents_one_live_per_number
  on public.sms_consents (e164)
  where revoked_at is null;

create index if not exists sms_consents_number_idx on public.sms_consents (e164);
create index if not exists sms_consents_recent_idx on public.sms_consents (created_at desc);

-- ============================================================================
-- RLS — nobody reads this without a session, and nobody writes it by hand.
-- ============================================================================
alter table public.sms_consents enable row level security;
alter table public.sms_consents force  row level security;

revoke all on public.sms_consents from anon;
grant select on public.sms_consents to authenticated;

/*
 * Readable by any signed-in user, because anyone who can send a text needs to
 * know whether they may. Written ONLY through the RPCs below, running as the
 * service role: the public form has no session at all, and a client that could
 * INSERT here could manufacture consent, which is the one thing this table
 * exists to make impossible.
 */
drop policy if exists sms_consents_select on public.sms_consents;
create policy sms_consents_select on public.sms_consents
  for select to authenticated using (true);

-- ============================================================================
-- Is this number allowed to be texted?
--
-- Returns the live consent or nothing. Callers treat "no row" as "no consent"
-- — absence means absent, so there is no third state to forget to handle.
-- ============================================================================
create or replace function public.sms_consent_status(p_e164 text)
returns table (
  consented    boolean,
  source       sms_consent_source,
  consented_at timestamptz,
  full_name    text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select true, c.source, c.created_at, c.full_name
    from public.sms_consents c
   where c.e164 = p_e164 and c.revoked_at is null
   order by c.created_at desc
   limit 1;
$$;

revoke all on function public.sms_consent_status(text) from public, anon;
grant execute on function public.sms_consent_status(text) to authenticated, service_role;

-- ============================================================================
-- Record a consent.
--
-- SECURITY DEFINER and granted to service_role only. The public form reaches
-- it through a Server Action, which is the boundary that validates and rate
-- limits; no browser can call this.
-- ============================================================================
create or replace function public.record_sms_consent(
  p_e164           text,
  p_consent_text   text,
  p_source         sms_consent_source,
  p_full_name      text default null,
  p_business_name  text default null,
  p_email          text default null,
  p_ip             inet default null,
  p_user_agent     text default null,
  p_recorded_by_id uuid default null,
  p_note           text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  /*
   * Re-consenting is not an error and must not raise. Someone who fills the
   * form twice, or a rep confirming what the form already captured, should
   * leave one live consent — the existing one, with its original date. The
   * FIRST agreement is the one that matters evidentially, so it is kept and
   * the duplicate is discarded.
   */
  select id into v_id
    from public.sms_consents
   where e164 = p_e164 and revoked_at is null
   limit 1;

  if v_id is not null then
    return v_id;
  end if;

  insert into public.sms_consents (
    e164, full_name, business_name, email, source, consent_text,
    ip, user_agent, recorded_by_id, note
  )
  values (
    p_e164, nullif(btrim(p_full_name), ''), nullif(btrim(p_business_name), ''),
    nullif(btrim(p_email), ''), p_source, p_consent_text,
    p_ip, p_user_agent, p_recorded_by_id, nullif(btrim(p_note), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_sms_consent(
  text, text, sms_consent_source, text, text, text, inet, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.record_sms_consent(
  text, text, sms_consent_source, text, text, text, inet, text, uuid, text
) to service_role;

-- ============================================================================
-- Withdraw consent.
--
-- Called when STOP arrives on the inbound webhook, and by an admin. Idempotent:
-- a second STOP from someone already opted out is normal, not an error.
-- ============================================================================
create or replace function public.revoke_sms_consent(
  p_e164   text,
  p_reason text default 'replied STOP'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.sms_consents
     set revoked_at = now(), revoked_reason = p_reason
   where e164 = p_e164 and revoked_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.revoke_sms_consent(text, text) from public, anon;
grant execute on function public.revoke_sms_consent(text, text) to service_role;

comment on table public.sms_consents is
  'Dated per-number record of SMS consent, carrying the exact wording agreed to. '
  'Required evidence for US carrier A2P registration. Revoked, never deleted.';
