-- =============================================================================
-- Email module P9: mail_list always plans with the real folder ids.
--
-- After a few calls in one session plpgsql switches to a cached GENERIC plan
-- (blind to which folders are asked for), and for this query that plan is
-- ~20x slower (460 ms vs 20 ms on a 4,000-message Inbox, measured by the
-- scale test). Planning costs ~5 ms; a fresh plan every call is the bargain.
-- =============================================================================

alter function public.mail_list(uuid[], boolean, int, timestamptz, text, boolean, boolean, timestamptz, timestamptz)
  set plan_cache_mode = force_custom_plan;
