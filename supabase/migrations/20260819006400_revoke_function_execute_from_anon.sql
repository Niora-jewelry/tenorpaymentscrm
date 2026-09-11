-- =============================================================================
-- Part 64: take EXECUTE away from `anon` on this project's own functions, and
-- on every function created from here on.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────
-- Several migrations end with `revoke execute on function X() from public;`
-- and consider the function closed. It is not. Supabase's project-level
-- `ALTER DEFAULT PRIVILEGES` grants EXECUTE **explicitly to `anon` and
-- `authenticated`** on every newly created function in `public`. A revoke
-- FROM PUBLIC removes the implicit grant to the pseudo-role PUBLIC and leaves
-- the two explicit ones untouched.
--
-- This is the same class of gap as migration 61's TRUNCATE, with one
-- difference that matters: PostgREST has no TRUNCATE verb, so that one had no
-- path from a browser. This one does. `POST /rest/v1/rpc/<name>` with nothing
-- but the publishable anon key — which ships in the client bundle and is
-- meant to be public — is exactly how PostgREST invokes a function.
--
-- Measured, not assumed. A plain curl carrying only the anon key, no session:
--
--   rpc/deal_name_conflict  -> "266278d0-904e-4a27-80ca-fa8d7ef50942"
--   rpc/count_user_records  -> 4
--   rpc/effective_grants    -> {"tab:2d11a273-…":"edit", …}
--
-- Three real leaks to an unauthenticated caller:
--   • `deal_name_conflict` confirms whether a business name exists in the CRM
--     and returns its record id — an enumeration oracle over the client list.
--   • `count_user_records` returns how many records a given user owns.
--   • `effective_grants` returns the whole permission map for any user id.
--
-- The rest blocked, but only by luck of their own internals: `auth_is_admin()`
-- reads `auth.uid()`, which is NULL for anon, so they raised "Admin only" or
-- "not found". That is a second line holding because the first was never
-- there. `set_record_values` — a write path — was among them.
--
-- ── WHY REVOKING FROM anon IS SAFE HERE ──────────────────────────────────
-- Checked every `.rpc(` call site in `src/` before writing this. Every one
-- runs server-side through either `supabaseAdmin()` (service_role, unaffected)
-- or `createSupabaseServerClient()` (the caller's own JWT, so `authenticated`).
-- Nothing in the browser calls an RPC, and the pre-auth flows — signup, login,
-- OTP, reset — all go through `supabaseAdmin()`.
--
-- The one function reached without a session is `session_state()` in
-- `src/proxy.ts`, which is fired in parallel with `getUser()` on every request
-- including anonymous ones. `anon` already lacked EXECUTE on it, and the proxy
-- already returns on `!user` **before** it looks at `stateError`, so the error
-- is discarded on that path exactly as its comment describes. No change.
--
-- ⚠️ `authenticated` keeps EXECUTE. The app depends on it, and those functions
-- do their own `auth_is_admin()` / membership checks with a real `auth.uid()`.
-- `service_role` is untouched — it is the server's own key.
--
-- ── BOTH HALVES, OR IT COMES BACK ────────────────────────────────────────
-- The revoke fixes the 95 functions that exist. The ALTER DEFAULT PRIVILEGES
-- is what stops function 96 from arriving with the grant restored — which is
-- precisely how the per-function `revoke ... from public` lines in earlier
-- migrations came to be worth nothing.
--
-- Extension-owned functions (citext, pg_trgm, pgcrypto …) are left alone:
-- `revoke ... on all functions in schema public` skips nothing, so this is
-- written as an explicit loop over functions with no `pg_depend` extension
-- dependency. Revoking operator-support functions an extension installed would
-- break index and cast behaviour for every role.
-- =============================================================================

do $$
declare
  fn record;
  n   int := 0;
begin
  for fn in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and not exists (
             select 1 from pg_depend d
              where d.objid = p.oid and d.deptype = 'e'
           )
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    execute format('revoke execute on function %s from anon', fn.sig);
    n := n + 1;
  end loop;
  raise notice 'revoked EXECUTE from anon on % function(s)', n;
end;
$$;

-- Future functions created by `postgres` — every migration in this project
-- runs as postgres, so this is the one that matters in practice.
alter default privileges in schema public
  revoke execute on functions from anon;

-- And functions created by `supabase_admin`. Wrapped for the same reason
-- migration 61 wraps its counterpart: `postgres` is not a member of that role
-- on a hosted project and the bare statement raises 42501, which must not take
-- the migration down with it.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke execute on functions from anon';
exception
  when insufficient_privilege then
    raise notice 'skipped supabase_admin default privileges (not a member) — postgres default applied';
end;
$$;
