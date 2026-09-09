-- =============================================================================
-- Auth module hardening: revoke EXECUTE from PUBLIC on every privileged
-- function
--
-- FOUND BY: auditing Module 2's own grants (the user asked "make sure
-- everything you wired is proper, no skip") turned up a bug class that
-- predates this session and affects the auth module too — worth fixing now
-- that it's found, not left for someone to discover the hard way.
--
-- THE BUG: `CREATE FUNCTION` grants EXECUTE to PUBLIC automatically unless
-- explicitly revoked. Every migration in this project (including the auth
-- foundation) wrote `revoke all on function X from anon, authenticated` —
-- which revokes THEIR OWN named ACL entries, but does nothing to the
-- separate PUBLIC entry every function still carries from creation. Since
-- `anon` and `authenticated` are implicit members of PUBLIC, they inherit
-- EXECUTE through that entry regardless of the explicit revoke. Verified
-- directly: `has_function_privilege('anon', 'complete_signup', 'EXECUTE')`
-- returns true today, despite the function's own header comment saying
-- "reachable only through the service role."
--
-- In practice this app never got exploited through it — every one of these
-- functions is called exclusively via `supabaseAdmin()` (service role,
-- which bypasses grants entirely) from `lib/auth/*`, confirmed by grepping
-- every `.rpc()` call site — so the grant gap and the actual call path never
-- lined up for a real request to exploit. But Supabase's PostgREST exposes
-- every function with any EXECUTE grant as a callable HTTP endpoint
-- independent of this app entirely — an external caller hitting
-- `/rest/v1/rpc/complete_signup` directly was never blocked by anything
-- except each function's own internal validation. That is not the intended
-- second layer this project's own convention describes.
-- =============================================================================

revoke execute on function
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
from public;

-- auth_is_admin(), session_state(), touch_last_seen() are genuinely called
-- via the request-scoped client (proxy.ts, lib/records/permissions.ts) —
-- revoke PUBLIC's blanket grant, then restate the deliberate authenticated
-- grant explicitly rather than leaving it to whatever PUBLIC happened to
-- carry.
revoke execute on function auth_is_admin()   from public;
revoke execute on function session_state()   from public;
revoke execute on function touch_last_seen() from public;
grant  execute on function auth_is_admin()   to authenticated;
grant  execute on function session_state()   to authenticated;
grant  execute on function touch_last_seen() to authenticated;
