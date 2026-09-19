-- =============================================================================
-- Part 90: narrow migration 89's sweep so it can never retire a live call.
--
-- ── WHAT 89 GOT WRONG ────────────────────────────────────────────────────
-- 89 retired any row matching:
--
--   status in ('queued','initiated','ringing') and twilio_call_sid is null
--   and started_at < now() - interval '2 minutes'
--
-- That was written on the belief that "no CallSid" means "Twilio never saw
-- this". It did not, and the audit before live testing found why:
--
--   * OUTBOUND — `/api/twilio/status` is the only writer of `twilio_call_sid`,
--     and it is subscribed to `completed` alone. For the whole duration of a
--     real call the row read status='queued', twilio_call_sid=null — exactly
--     the signature of a dial that never left the browser. Any conversation
--     lasting over two minutes would have been marked 'failed' WHILE IT WAS
--     STILL IN PROGRESS.
--
--   * INBOUND — the row is inserted at 'ringing' and finalised later by
--     `<Dial action>` -> `/api/twilio/inbound-status`. It carried no SID
--     either, so a three-minute inbound call met the same fate.
--
-- The final callback would have corrected the row afterwards, so this was not
-- permanent damage — but the history told a lie while anyone was watching, and
-- a single lost callback would have frozen it that way. Found by reading the
-- flows before the first real call, not after.
--
-- ── TWO CHANGES, BELT AND BRACES ─────────────────────────────────────────
-- The code half (same commit): the voice route now stamps `twilio_call_sid`
-- the moment Twilio first reaches us — on the inbound INSERT, where the SID is
-- already in hand, and on the outbound leg as soon as the TwiML App request
-- arrives carrying both the SID and our row id. So a SID now appears within a
-- second of dialling rather than at hang-up.
--
-- This half stops trusting that entirely and narrows the condition to the one
-- state that NOTHING except `createOutboundCall` can produce:
--
--   direction = 'out'  AND  status = 'queued'
--
-- 'initiated' and 'ringing' are Twilio's words, written by callbacks, and are
-- no longer swept at any age — a row Twilio is actively reporting on is
-- Twilio's to finish. 'queued' on an outbound row is ours alone: it is written
-- once, before the browser dials, and any other writer would have supplied a
-- SID with it.
--
-- Worst case now is the opposite of the old one, and the right way round: a
-- dial that dies in a way we cannot see stays 'queued' a little longer, rather
-- than a live call being declared dead.
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
     where direction = 'out'
       and status = 'queued'
       and twilio_call_sid is null
       and started_at < now() - interval '2 minutes'
       and deleted_at is null
    returning 1
  )
  select count(*) into v_count from stale;

  return v_count;
end;
$$;
