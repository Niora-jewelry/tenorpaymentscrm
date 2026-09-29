-- ============================================================================
-- Prerequisites for the residuals port.
--
-- Daniel's residuals migrations lean on two things his CRM had and ours does
-- not. Found by pre-flighting every function and table the port references
-- against this database, rather than by applying 39 migrations and reading the
-- first error.
--
-- Deliberately a separate, numbered migration rather than statements bolted
-- onto the front of his foundation file: these are OURS, they are the only
-- part of the port that is not his work, and a reader tracing a residuals
-- table back to its origin should not find our scaffolding hidden inside a
-- file whose header says it came from somewhere else.
-- ============================================================================

-- ── 1. tg_set_updated_at ────────────────────────────────────────────────────
-- Referenced 22 times across the port. His CRM defines it once in its profiles
-- migration and every table with an `updated_at` column hangs a trigger on it.
--
-- We had no shared equivalent — only `phone_contacts_touch()`, which does the
-- same thing for one table. This is that function generalised, and the phone
-- contacts one is deliberately left alone: rewriting a working trigger to
-- prove a point is how a migration that should have been additive breaks
-- something.
--
-- `search_path` is pinned per CLAUDE.md's standing rule for SECURITY DEFINER
-- functions. It is not strictly a definer — a trigger function runs as the
-- statement's invoker — but pinning it costs nothing and removes the question.
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.tg_set_updated_at() is
  'Shared BEFORE UPDATE trigger: stamps updated_at. Used by every residuals '
  'table carrying that column.';

revoke all on function public.tg_set_updated_at() from public, anon, authenticated;

-- ── 2. residual_audit_log ───────────────────────────────────────────────────
-- `residual_period_history` reads a generic `audit_log` table to show the
-- manual-edit trail beside the acknowledgments and sign-offs. His CRM has one,
-- populated by a trigger across every table.
--
-- We do not, and we should not simply create one: CLAUDE.md is explicit that
-- `lib/activity/log.ts` is the ONLY writer of the activity log, and a second
-- general-purpose audit table would be a second answer to "what happened to
-- this record" — exactly the divergence that rule exists to prevent.
--
-- So this is scoped to residuals and named for it. It is a different log about
-- a different domain, not a competing copy of an existing one, and the
-- reconciliation grid is the only thing that reads it.
--
-- WHY IT IS POPULATED BY A TRIGGER RATHER THAN BY THE RPCs
-- The same argument his module makes for recompute invalidation: attach the
-- guard to the FACT, not to the caller. A trail written by each RPC is a trail
-- the author of the next RPC can forget; a trigger on the table covers the
-- import paths, manual entry, and any future writer, and cannot be skipped.
create type public.residual_audit_action as enum ('insert','update','delete','restore');

create table if not exists public.residual_audit_log (
  id              uuid primary key default gen_random_uuid(),
  table_name      text not null,
  record_id       uuid not null,
  action          public.residual_audit_action not null,
  actor_id        uuid references public.profiles(id) on delete set null,
  changed_fields  text[],
  before_data     jsonb,
  after_data      jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists residual_audit_log_table_record_idx
  on public.residual_audit_log (table_name, record_id, created_at desc);
create index if not exists residual_audit_log_actor_idx
  on public.residual_audit_log (actor_id, created_at desc);

alter table public.residual_audit_log enable row level security;
alter table public.residual_audit_log force  row level security;

revoke all on public.residual_audit_log from anon;
grant select on public.residual_audit_log to authenticated;

-- Admins read it; nothing writes it from a client. The rows come from the
-- trigger below, running as the definer.
drop policy if exists residual_audit_log_select on public.residual_audit_log;
create policy residual_audit_log_select on public.residual_audit_log
  for select to authenticated using (auth_is_admin());

/*
 * The writer.
 *
 * `changed_fields` is computed rather than passed in, so it cannot disagree
 * with the before/after payloads sitting beside it — a hand-maintained list of
 * what changed is a second statement of something the data already says, and
 * the day the two differ the list wins silently.
 *
 * A soft delete is recorded as 'delete' and a soft undelete as 'restore',
 * because that is what they are to a reader. The UPDATE that performed them is
 * not also logged: one action, one row.
 */
create or replace function public.tg_residual_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action public.residual_audit_action;
  v_before jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_after  jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_fields text[];
begin
  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'DELETE' then
    v_action := 'delete';
  elsif old.deleted_at is null and new.deleted_at is not null then
    v_action := 'delete';
  elsif old.deleted_at is not null and new.deleted_at is null then
    v_action := 'restore';
  else
    v_action := 'update';
  end if;

  if tg_op = 'UPDATE' then
    select array_agg(key order by key)
      into v_fields
      from jsonb_each(v_after)
     where v_before -> key is distinct from v_after -> key;

    -- Nothing actually changed. A row saying so is noise in a trail that is
    -- read when something has gone wrong.
    if v_fields is null then
      return new;
    end if;
  end if;

  insert into public.residual_audit_log
    (table_name, record_id, action, actor_id, changed_fields, before_data, after_data)
  values (
    tg_table_name,
    coalesce((v_after ->> 'id')::uuid, (v_before ->> 'id')::uuid),
    v_action,
    auth.uid(),
    v_fields,
    v_before,
    v_after
  );

  return coalesce(new, old);
end;
$$;

comment on function public.tg_residual_audit() is
  'Writes residual_audit_log. Attached to the tables whose manual edits the '
  'reconciliation grid reports, so the trail covers every writer rather than '
  'the ones an RPC author remembered.';

revoke all on function public.tg_residual_audit() from public, anon, authenticated;

comment on table public.residual_audit_log is
  'Manual-edit trail for residuals, read by residual_period_history. Scoped to '
  'this module deliberately: a second general-purpose audit table would compete '
  'with record_activity, whose single-writer rule exists to stop exactly that.';
