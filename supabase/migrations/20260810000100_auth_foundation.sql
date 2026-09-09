-- =============================================================================
-- TapDash CRM — Phase 1: Authentication & Identity foundation
--
-- Source of truth: "1 - Login page.docx" (Phase 1 spec).
--
-- Standing conventions established here for the ENTIRE project:
--   * RLS is ENABLED and FORCED on every table, default-deny.
--   * Privileged reads/writes go through SECURITY DEFINER functions that pin
--     search_path (closes the search-path hijack class).
--   * Audit history is append-only at the database, not by convention.
--   * No auth logic anywhere may reference a role by NAME. Code reads
--     roles.is_admin. New roles are configuration, never migrations.
-- =============================================================================

create extension if not exists citext;
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------
create type user_status  as enum ('active', 'suspended');
create type invite_status as enum ('pending', 'accepted', 'revoked', 'expired');
create type otp_purpose  as enum ('signup', 'reset');

-- -----------------------------------------------------------------------------
-- roles / permissions / role_permissions
--
-- The Phase 1 spec requires this trio to exist from the first migration. The
-- granular Hidden/View/Edit grant model (Admin Module Plan) arrives with the
-- records module and layers on top; it does not replace these.
-- -----------------------------------------------------------------------------
create table roles (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  is_admin   boolean not null default false,
  is_system  boolean not null default false,
  created_at timestamptz not null default now()
);
comment on column roles.is_admin is
  'All-or-nothing Admin module access. The ONLY authorization signal Phase 1 reads.';

create table permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  description text
);

create table role_permissions (
  role_id       uuid not null references roles(id) on delete cascade,
  permission_id uuid not null references permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- -----------------------------------------------------------------------------
-- profiles — extends auth.users
-- -----------------------------------------------------------------------------
create table profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               citext not null unique,
  full_name           text,
  role_id             uuid not null references roles(id),
  status              user_status not null default 'active',
  sessions_valid_from timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  last_login_at       timestamptz,
  last_seen_at        timestamptz,
  deleted_at          timestamptz
);
comment on column profiles.sessions_valid_from is
  'Session revocation epoch. Middleware rejects any access token issued before this '
  'instant. Bumped on password change (spec: "all other active sessions invalidated") '
  'and reused later for the Admin doc''s Pause and Soft-delete user levels. Refresh-'
  'token revocation alone would leave an already-issued access token live until expiry.';
comment on column profiles.last_seen_at is
  'Fallback enforcement for the 24h sliding session if the Supabase project plan does '
  'not expose an inactivity timeout setting.';

create index profiles_role on profiles (role_id);

-- -----------------------------------------------------------------------------
-- invites — the only path to an account. No open registration exists anywhere.
-- -----------------------------------------------------------------------------
create table invites (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null,
  invited_by  uuid references profiles(id) on delete set null,
  role_id     uuid not null references roles(id),
  status      invite_status not null default 'pending',
  expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz
);

-- Spec: "email (citext, unique among pending invites)"
create unique index invites_one_pending_per_email
  on invites (email) where status = 'pending';

create index invites_email_lookup on invites (email, status);

-- -----------------------------------------------------------------------------
-- otp_challenges
--
-- Deliberately our own table rather than Supabase's built-in OTP. Three spec
-- requirements the built-in cannot meet:
--   1. max 5 attempts, then a new code is required
--   2. 60-second resend cooldown
--   3. "no half-usable account may exist" — which requires that the auth.users
--      row is NOT created until a password is actually set.
--
-- code_hash is HMAC-SHA256(code, OTP_PEPPER). The plaintext code exists only in
-- the outbound email; a database dump yields nothing replayable.
--
-- ticket_hash proves "this session verified the OTP" server-side, so the client
-- never carries that fact as trusted state.
-- -----------------------------------------------------------------------------
create table otp_challenges (
  id                 uuid primary key default gen_random_uuid(),
  email              citext not null,
  purpose            otp_purpose not null,
  code_hash          bytea not null,
  attempts           integer not null default 0,
  last_sent_at       timestamptz not null default now(),
  expires_at         timestamptz not null,
  consumed_at        timestamptz,
  ticket_hash        bytea,
  ticket_expires_at  timestamptz,
  ticket_used_at     timestamptz,
  ip                 inet,
  created_at         timestamptz not null default now()
);

create index otp_challenges_lookup
  on otp_challenges (email, purpose, created_at desc);
create index otp_challenges_ticket
  on otp_challenges (ticket_hash) where ticket_hash is not null;

-- -----------------------------------------------------------------------------
-- auth_audit_log — append-only
--
-- Spec: "records login success/failure, OTP requests and verifications, password
-- changes, invite acceptance; each entry with timestamp, IP, and user agent."
-- Also the source for the Admin doc's per-user login-history drill-down.
-- -----------------------------------------------------------------------------
create table auth_audit_log (
  id              bigint generated always as identity primary key,
  actor_id        uuid references profiles(id) on delete set null,
  event_type      text not null,
  email_attempted citext,
  ip              inet,
  user_agent      text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index auth_audit_actor on auth_audit_log (actor_id, created_at desc);
create index auth_audit_email on auth_audit_log (email_attempted, created_at desc);
create index auth_audit_event on auth_audit_log (event_type, created_at desc);

-- -----------------------------------------------------------------------------
-- rate_limit_counters
--
-- Not in the spec. Added because the spec only caps OTP attempts and resends —
-- without this, the login and OTP endpoints are an open guessing oracle and a
-- free mail relay. Postgres-backed so no extra infrastructure is required.
-- -----------------------------------------------------------------------------
create table rate_limit_counters (
  key          text primary key,
  window_start timestamptz not null,
  count        integer not null default 0
);

-- =============================================================================
-- Append-only enforcement
-- =============================================================================
create or replace function refuse_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Table % is append-only and cannot be modified or deleted', tg_table_name
    using errcode = '42501';
end;
$$;

create trigger auth_audit_log_no_update
  before update on auth_audit_log
  for each row execute function refuse_mutation();

create trigger auth_audit_log_no_delete
  before delete on auth_audit_log
  for each row execute function refuse_mutation();

-- =============================================================================
-- Row Level Security — default deny on EVERY table
-- =============================================================================
alter table roles               enable row level security;
alter table roles               force  row level security;
alter table permissions         enable row level security;
alter table permissions         force  row level security;
alter table role_permissions    enable row level security;
alter table role_permissions    force  row level security;
alter table profiles            enable row level security;
alter table profiles            force  row level security;
alter table invites             enable row level security;
alter table invites             force  row level security;
alter table otp_challenges      enable row level security;
alter table otp_challenges      force  row level security;
alter table auth_audit_log      enable row level security;
alter table auth_audit_log      force  row level security;
alter table rate_limit_counters enable row level security;
alter table rate_limit_counters force  row level security;

-- Strip the schema back, then grant deliberately, table by table.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Admin check helper
-- -----------------------------------------------------------------------------
create or replace function auth_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select r.is_admin
      from profiles p
      join roles r on r.id = p.role_id
     where p.id = auth.uid()
       and p.status = 'active'
       and p.deleted_at is null
  ), false);
$$;

-- -----------------------------------------------------------------------------
-- profiles policies
-- A user reads their own row. Admins read all. Nobody may write role_id, status
-- or sessions_valid_from from the client under any circumstances — those are
-- reachable only through the service role or definer functions.
-- -----------------------------------------------------------------------------
create policy profiles_select_self on profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_select_admin on profiles
  for select to authenticated
  using (auth_is_admin());

create policy profiles_update_self on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

grant select on profiles to authenticated;
-- Column-level grant: RLS cannot restrict columns, GRANT can.
grant update (full_name) on profiles to authenticated;

-- -----------------------------------------------------------------------------
-- roles / permissions / role_permissions — readable by signed-in users so the
-- UI can render role names; writes are admin-only.
-- -----------------------------------------------------------------------------
create policy roles_select on roles
  for select to authenticated using (true);
create policy permissions_select on permissions
  for select to authenticated using (true);
create policy role_permissions_select on role_permissions
  for select to authenticated using (true);

create policy roles_write_admin on roles
  for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy permissions_write_admin on permissions
  for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy role_permissions_write_admin on role_permissions
  for all to authenticated using (auth_is_admin()) with check (auth_is_admin());

grant select on roles, permissions, role_permissions to authenticated;
grant insert, update, delete on roles, permissions, role_permissions to authenticated;

-- -----------------------------------------------------------------------------
-- auth_audit_log — admins read. Nobody writes directly; writes go through
-- log_auth_event(). UPDATE/DELETE are additionally blocked by trigger.
-- -----------------------------------------------------------------------------
create policy auth_audit_select_admin on auth_audit_log
  for select to authenticated using (auth_is_admin());

grant select on auth_audit_log to authenticated;

-- -----------------------------------------------------------------------------
-- invites, otp_challenges, rate_limit_counters
--
-- NO policy is created for these, and no grant is issued. They are unreachable
-- from anon and authenticated entirely. Access is exclusively via the SECURITY
-- DEFINER functions below or the service role.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Privileged operations (SECURITY DEFINER, pinned search_path)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- log_auth_event
-- -----------------------------------------------------------------------------
create or replace function log_auth_event(
  p_event_type      text,
  p_actor_id        uuid    default null,
  p_email_attempted citext  default null,
  p_ip              inet    default null,
  p_user_agent      text    default null,
  p_metadata        jsonb   default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into auth_audit_log (actor_id, event_type, email_attempted, ip, user_agent, metadata)
  values (p_actor_id, p_event_type, p_email_attempted, p_ip, left(p_user_agent, 512), p_metadata);
$$;

-- -----------------------------------------------------------------------------
-- find_pending_invite
--
-- Looked up by NORMALIZED EMAIL ONLY. Never by an id supplied by the client —
-- otherwise a user could aim at an invite carrying a higher role. Expiry is
-- evaluated against database now(), never a client clock.
-- -----------------------------------------------------------------------------
create or replace function find_pending_invite(p_email citext)
returns table (invite_id uuid, role_id uuid, expires_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select i.id, i.role_id, i.expires_at
    from invites i
   where i.email = lower(btrim(p_email))
     and i.status = 'pending'
     and i.expires_at > now()
   limit 1;
$$;

-- -----------------------------------------------------------------------------
-- email_is_registered — used to route an existing user to /login (spec §4)
-- -----------------------------------------------------------------------------
create or replace function email_is_registered(p_email citext)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from profiles
     where email = lower(btrim(p_email))
       and deleted_at is null
  );
$$;

-- -----------------------------------------------------------------------------
-- issue_otp_challenge
--
-- Enforces the 60-second resend cooldown against database time, and invalidates
-- any previous unconsumed challenge so only one code is ever live per purpose.
-- Returns cooldown_remaining > 0 when refused.
-- -----------------------------------------------------------------------------
create or replace function issue_otp_challenge(
  p_email        citext,
  p_purpose      otp_purpose,
  p_code_hash    bytea,
  p_ttl_seconds  integer default 600,
  p_cooldown_seconds integer default 60,
  p_ip           inet default null
)
returns table (issued boolean, cooldown_remaining integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email     citext := lower(btrim(p_email));
  v_last_sent timestamptz;
  v_remaining integer;
begin
  select max(last_sent_at) into v_last_sent
    from otp_challenges
   where email = v_email and purpose = p_purpose;

  if v_last_sent is not null then
    v_remaining := ceil(extract(epoch from
      (v_last_sent + make_interval(secs => p_cooldown_seconds)) - now()));
    if v_remaining > 0 then
      return query select false, v_remaining;
      return;
    end if;
  end if;

  -- Only one live challenge per (email, purpose).
  update otp_challenges
     set consumed_at = now()
   where email = v_email and purpose = p_purpose and consumed_at is null;

  insert into otp_challenges (email, purpose, code_hash, expires_at, ip)
  values (v_email, p_purpose, p_code_hash, now() + make_interval(secs => p_ttl_seconds), p_ip);

  return query select true, 0;
end;
$$;

-- -----------------------------------------------------------------------------
-- verify_otp_challenge
--
-- Atomic. The whole check-and-consume happens under one row lock, so two
-- concurrent submissions of a valid code cannot both succeed — the spec's
-- "OTPs are single-use; double-submission is rejected".
--
-- Note on constant-time comparison: the bytea equality below is not formally
-- constant-time, but the 5-attempt cap makes timing unsamplable, and the value
-- compared is a 32-byte HMAC whose timing delta is far below network jitter.
-- -----------------------------------------------------------------------------
create or replace function verify_otp_challenge(
  p_email       citext,
  p_purpose     otp_purpose,
  p_code_hash   bytea,
  p_ticket_hash bytea,
  p_max_attempts integer default 5,
  p_ticket_ttl_seconds integer default 900
)
returns table (ok boolean, reason text, attempts_remaining integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email citext := lower(btrim(p_email));
  v       otp_challenges%rowtype;
begin
  select * into v
    from otp_challenges
   where email = v_email and purpose = p_purpose and consumed_at is null
   order by created_at desc
   limit 1
   for update;

  if not found then
    return query select false, 'NO_CHALLENGE'::text, 0; return;
  end if;

  if v.expires_at <= now() then
    return query select false, 'EXPIRED'::text, 0; return;
  end if;

  if v.attempts >= p_max_attempts then
    return query select false, 'TOO_MANY_ATTEMPTS'::text, 0; return;
  end if;

  if v.code_hash = p_code_hash then
    update otp_challenges
       set consumed_at       = now(),
           ticket_hash       = p_ticket_hash,
           ticket_expires_at = now() + make_interval(secs => p_ticket_ttl_seconds)
     where id = v.id;
    return query select true, 'OK'::text, 0; return;
  end if;

  update otp_challenges set attempts = attempts + 1 where id = v.id;
  return query select false, 'INVALID_CODE'::text, (p_max_attempts - v.attempts - 1); return;
end;
$$;

-- -----------------------------------------------------------------------------
-- redeem_signup_ticket
--
-- Single-use. Proves the caller verified an OTP for this email, without ever
-- trusting client-held state.
-- -----------------------------------------------------------------------------
create or replace function redeem_signup_ticket(
  p_email       citext,
  p_purpose     otp_purpose,
  p_ticket_hash bytea
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  update otp_challenges
     set ticket_used_at = now()
   where email = lower(btrim(p_email))
     and purpose = p_purpose
     and ticket_hash = p_ticket_hash
     and ticket_used_at is null
     and ticket_expires_at > now()
  returning id into v_id;

  return v_id is not null;
end;
$$;

-- -----------------------------------------------------------------------------
-- complete_signup
--
-- Runs AFTER the auth.users row is created by the service role. Creates the
-- profile with the role_id carried by the invite, and marks the invite accepted
-- — in one transaction. Re-validates the invite here, not only at OTP time, so
-- an invite revoked or expired mid-flow halts the flow (spec §4 edge cases).
-- -----------------------------------------------------------------------------
create or replace function complete_signup(
  p_user_id   uuid,
  p_email     citext,
  p_full_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  citext := lower(btrim(p_email));
  v_invite invites%rowtype;
begin
  select * into v_invite
    from invites
   where email = v_email
     and status = 'pending'
     and expires_at > now()
   for update;

  if not found then
    raise exception 'INVITE_NOT_VALID' using errcode = 'P0001';
  end if;

  insert into profiles (id, email, full_name, role_id)
  values (p_user_id, v_email, nullif(btrim(coalesce(p_full_name, '')), ''), v_invite.role_id);

  update invites
     set status = 'accepted', accepted_at = now()
   where id = v_invite.id;

  return v_invite.role_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- revoke_other_sessions — the epoch bump behind "password change invalidates
-- all other active sessions" (spec §5).
-- -----------------------------------------------------------------------------
create or replace function revoke_other_sessions(p_user_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update profiles set sessions_valid_from = now() where id = p_user_id;
$$;

-- -----------------------------------------------------------------------------
-- touch_last_seen / mark_login — session sliding + last-login column
-- -----------------------------------------------------------------------------
-- Takes no argument and derives the caller from auth.uid(), so it is safe to
-- expose to authenticated users: nobody can touch another user's row.
create or replace function touch_last_seen()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update profiles set last_seen_at = now() where id = auth.uid();
$$;

create or replace function mark_login(p_user_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update profiles
     set last_login_at = now(), last_seen_at = now()
   where id = p_user_id;
$$;

-- -----------------------------------------------------------------------------
-- session_state — one read for everything middleware needs per request:
-- is this user active, are they admin, has their session epoch moved, and when
-- were they last seen (the 24h sliding-session fallback).
--
-- Derives the caller from auth.uid() rather than taking a user id, so exposing
-- it to authenticated users cannot leak anyone else's account state.
-- -----------------------------------------------------------------------------
create or replace function session_state()
returns table (
  status              user_status,
  is_admin            boolean,
  sessions_valid_from timestamptz,
  last_seen_at        timestamptz,
  deleted_at          timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.status, r.is_admin, p.sessions_valid_from, p.last_seen_at, p.deleted_at
    from profiles p
    join roles r on r.id = p.role_id
   where p.id = auth.uid();
$$;

-- Same data, addressed by user id. Service-role only — used by the login flow
-- to reject a suspended user immediately after password verification.
create or replace function session_state_for(p_user_id uuid)
returns table (
  status              user_status,
  is_admin            boolean,
  sessions_valid_from timestamptz,
  last_seen_at        timestamptz,
  deleted_at          timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.status, r.is_admin, p.sessions_valid_from, p.last_seen_at, p.deleted_at
    from profiles p
    join roles r on r.id = p.role_id
   where p.id = p_user_id;
$$;

-- -----------------------------------------------------------------------------
-- rate_limit_hit — atomic fixed-window counter. Returns true when ALLOWED.
-- -----------------------------------------------------------------------------
create or replace function rate_limit_hit(
  p_key            text,
  p_limit          integer,
  p_window_seconds integer
)
returns table (allowed boolean, current_count integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now    timestamptz := now();
  v_start  timestamptz;
  v_count  integer;
begin
  insert into rate_limit_counters as c (key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (key) do update
     set count = case
           when c.window_start < v_now - make_interval(secs => p_window_seconds) then 1
           else c.count + 1 end,
         window_start = case
           when c.window_start < v_now - make_interval(secs => p_window_seconds) then v_now
           else c.window_start end
  returning c.count, c.window_start into v_count, v_start;

  return query select
    v_count <= p_limit,
    v_count,
    greatest(0, ceil(extract(epoch from
      (v_start + make_interval(secs => p_window_seconds)) - v_now))::integer);
end;
$$;

-- -----------------------------------------------------------------------------
-- expire_stale_invites — housekeeping, safe to run on a schedule.
-- -----------------------------------------------------------------------------
create or replace function expire_stale_invites()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  update invites
     set status = 'expired'
   where status = 'pending' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Function grants
--
-- Three functions are callable by signed-in users, and each derives the caller
-- from auth.uid() so it cannot be pointed at somebody else:
--   auth_is_admin()   — the RLS policies depend on it
--   session_state()   — middleware reads it on every request
--   touch_last_seen() — middleware slides the session on every request
--
-- Everything else is service-role only: revoked from anon and authenticated,
-- reachable exclusively from trusted server code.
-- -----------------------------------------------------------------------------
revoke all on function
  log_auth_event(text, uuid, citext, inet, text, jsonb),
  find_pending_invite(citext),
  email_is_registered(citext),
  issue_otp_challenge(citext, otp_purpose, bytea, integer, integer, inet),
  verify_otp_challenge(citext, otp_purpose, bytea, bytea, integer, integer),
  redeem_signup_ticket(citext, otp_purpose, bytea),
  complete_signup(uuid, citext, text),
  revoke_other_sessions(uuid),
  mark_login(uuid),
  session_state_for(uuid),
  rate_limit_hit(text, integer, integer),
  expire_stale_invites()
from anon, authenticated;

grant execute on function auth_is_admin()   to authenticated;
grant execute on function session_state()   to authenticated;
grant execute on function touch_last_seen() to authenticated;

-- =============================================================================
-- Seeds
--
-- Spec: "Phase 1 seeds super_admin plus a placeholder role; no auth logic
-- anywhere in the codebase may hardcode role names."
--
-- NO USER IS SEEDED. The first human arrives through the bootstrap invite
-- (supabase/seed/create-invite.sql) and the normal signup screens, so no
-- default credential can ever be left behind.
-- =============================================================================
insert into roles (name, slug, is_admin, is_system) values
  ('Super Admin', 'super_admin', true,  true),
  ('Member',      'member',      false, true);

insert into permissions (key, description) values
  ('admin.access',      'Access the Admin module (all-or-nothing)'),
  ('recycle_bin.access','Access the Recycle Bin (admin-only, not grantable)');

insert into role_permissions (role_id, permission_id)
select r.id, p.id
  from roles r cross join permissions p
 where r.slug = 'super_admin';
