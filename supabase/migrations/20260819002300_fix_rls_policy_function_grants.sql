-- =============================================================================
-- Fix: can_see_record() / record_visible() need EXECUTE granted to
-- authenticated after all
--
-- FOUND BY: /leads erroring live with "permission denied for function
-- can_see_record" the moment a real signed-in user hit it — the previous
-- hardening pass (migration 20) revoked EXECUTE on these from
-- authenticated on the reasoning that they're "called only from inside
-- other SECURITY DEFINER functions or RLS policies, never a direct client
-- RPC." That reasoning is wrong for the RLS-policy half of that sentence:
-- when a function is referenced inside a policy's USING clause
-- (`records_select`, `notes_all`, `updates_all`, and every other "visible
-- iff the parent record is visible" policy from migration 9), Postgres
-- evaluates that policy AS THE QUERYING ROLE — here, `authenticated`, via
-- the request-scoped client — not as the function's own SECURITY DEFINER
-- context. The DEFINER context only kicks in once the function body starts
-- executing; reaching it from a policy still requires the querying role to
-- hold EXECUTE, exactly like calling it directly would.
--
-- effective_grant() is unaffected — it is never referenced inside any RLS
-- policy, only called directly via supabaseAdmin() (service role, which
-- bypasses grants entirely) — so it correctly stays ungranted to
-- authenticated.
-- =============================================================================

grant execute on function can_see_record(uuid)   to authenticated;
grant execute on function record_visible(uuid)   to authenticated;
