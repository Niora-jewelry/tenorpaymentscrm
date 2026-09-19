-- =============================================================================
-- Part 87: `records_insert` called `effective_grant()` directly, and 86 revoked
-- it. This restores creation without restoring the leak.
--
-- ── THE MISTAKE, PLAINLY ─────────────────────────────────────────────────
-- Migration 86 revoked EXECUTE on `effective_grant(uuid, grant_scope, uuid,
-- uuid)` from `authenticated`, on the stated grounds that "no RLS policy on any
-- table calls `effective_grant` directly".
--
-- That check was real, and it was run BEFORE migration 81 — which then added a
-- policy that does exactly that:
--
--   create policy records_insert ... with check (
--     ... or exists (select 1 from modules m
--                     where not m.admin_only
--                       and effective_grant(auth.uid(), 'module', m.id, null) = 'edit'))
--
-- An RLS policy expression is evaluated as the QUERYING role, not as the table
-- owner, so `authenticated` needs EXECUTE on everything a policy names. After
-- 86 every insert died with:
--
--   error: permission denied for function effective_grant
--
-- Caught by `flow.integration.test.ts`, which runs the real lifecycle against
-- the live database as `authenticated` — twelve tests, the first being "creates
-- a record with no memberships (a raw insert, mirroring createRecord())".
--
-- ── THE FIX, AND WHY NOT JUST RE-GRANT ───────────────────────────────────
-- Re-granting EXECUTE would work and would put the leak back: the point of 86
-- is that a member can otherwise ask the database what ANY user's grant on ANY
-- scope is, one call at a time.
--
-- `module_editable(p_module)` already answers precisely the question this
-- policy asks, it is SECURITY DEFINER — so it runs as `postgres` and needs no
-- privilege from the caller — and `authenticated` already holds EXECUTE on it
-- (migration 81). Routing the policy through it keeps the revoke and keeps
-- creation working.
--
-- It also removes the last duplicated copy of "does this person hold Edit on
-- this module", which is the reason the two could drift apart in the first
-- place.
--
-- ── RE-CHECKED, PROPERLY THIS TIME ───────────────────────────────────────
-- Every non-definer context was scanned for references to the functions 86
-- revoked — all RLS policies (qual AND with_check), all CHECK constraints, all
-- index expressions and all views. `records_insert` was the only hit, and this
-- migration is it.
-- =============================================================================

drop policy if exists records_insert on public.records;

create policy records_insert on public.records
  for insert to authenticated
  with check (
    creator_kind = 'user'
    and creator_user_id = auth.uid()
    and (
      auth_is_admin()
      or exists (
        select 1
          from modules m
         where not m.admin_only
           and module_editable(m.id)
      )
    )
  );
