-- =============================================================================
-- Part 89: a dial that never reached Twilio stayed "queued" forever.
--
-- ── THE SEQUENCE ─────────────────────────────────────────────────────────
-- `createOutboundCall` inserts the row BEFORE the browser dials, and that
-- ordering is deliberate — the row's id is the correlation key every callback
-- carries back (`?callId=…`), so it has to exist first. The browser then hands
-- the number to the Twilio Device.
--
-- If that hand-off never happens, nothing finalises the row:
--
--   row inserted  status='queued', twilio_call_sid=null
--   Device fails  (microphone denied, CSP blocked the WebSocket, bad token,
--                  no network, or the tab was simply closed)
--   ...           no call was ever created at Twilio, so no status callback
--                 is ever sent, and the row sits at 'queued' permanently
--
-- Two such rows are in this database right now, from the failed dials during
-- the 31000/31401 debugging on 2026-09-18 — both with `twilio_call_sid` null,
-- which is the tell: Twilio never saw them.
--
-- Left alone, every failed dial adds another permanent "queued" entry to the
-- call history. It is not a data-loss bug, it is a truth bug: the log says a
-- call is in progress and it never was.
--
-- ── WHY A SWEEP AND NOT A CLIENT-SIDE FIX ────────────────────────────────
-- Having the browser report its own failure is a good addition and is NOT
-- sufficient on its own: the cases that produce these rows include the tab
-- closing and the network dropping, which are exactly the cases where the
-- browser cannot report anything. The correction has to be able to happen
-- without it.
--
-- ── THE CONDITION IS NARROW ON PURPOSE ───────────────────────────────────
-- Only rows that Twilio has never acknowledged — `twilio_call_sid is null` —
-- and only after a grace period. A row WITH a sid is Twilio's to finalise and
-- is never touched here, however old it looks, because a genuinely long call
-- is indistinguishable from a stuck one by age alone.
--
-- Two minutes is well past the moment the Device either connects or errors,
-- and short enough that a failed dial corrects itself before anyone reloads
-- and wonders. The status is set to 'failed', which is Twilio's own word for
-- this outcome, so nothing downstream needs a new case.
-- =============================================================================

create or replace function public.expire_stale_phone_calls()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with stale as (
    update phone_calls
       set status  = 'failed',
           ended_at = coalesce(ended_at, now())
     where status in ('queued', 'initiated', 'ringing')
       and twilio_call_sid is null
       and started_at < now() - interval '2 minutes'
       and deleted_at is null
    returning 1
  )
  select count(*) into v_count from stale;

  return v_count;
end;
$$;

-- Service role only. The app calls it on the call-history read path with the
-- admin client, for the same reason `phone_calls` grants no INSERT to
-- `authenticated` (migration 68): one writer, and it is never the browser.
revoke execute on function public.expire_stale_phone_calls() from public, anon, authenticated;
grant execute on function public.expire_stale_phone_calls() to service_role;


-- The two rows already stranded. Same condition as the function, so this is
-- the sweep applied once to the backlog rather than a different rule.
update phone_calls
   set status = 'failed',
       ended_at = coalesce(ended_at, now())
 where status in ('queued', 'initiated', 'ringing')
   and twilio_call_sid is null
   and started_at < now() - interval '2 minutes'
   and deleted_at is null;
