-- ============================================================================
-- The risk tier never resolved from a merchant's Pricing tab.
-- ============================================================================
-- `residual_tier_from_pricing_choice` compares the record's stored value
-- against `residual_risk_tiers.drawer_option`, and the ported comment explains
-- the design:
--
--   'residual_risk_tiers.drawer_option exists precisely for this join, and our
--    four choices match it character for character: "No risk", "Low risk",
--    "Moderate risk", "High risk". Resolved through the table rather than a
--    CASE so that renaming a choice is a data change in one place.'
--
-- The reasoning is right and the premise is false in THIS database. Records
-- here store the choice's KEY, not its label:
--
--   Apex Landscaping     pricing_risk_level = 'moderate_risk'
--   Bella Cafe           pricing_risk_level = 'low_risk'
--   Bluebird Coffee      pricing_risk_level = 'no_risk'
--
-- while `drawer_option` holds 'Moderate risk', 'Low risk', 'No risk'. Measured
-- before this migration:
--
--   residual_tier_from_pricing_choice('low_risk')      -> NULL
--   residual_tier_from_pricing_choice('Low risk')      -> low
--   residual_tier_from_pricing_choice('moderate_risk') -> NULL
--
-- ── WHY THIS WAS INVISIBLE ──────────────────────────────────────────────────
-- Returning NULL is the CORRECT refusal — the original comment is explicit
-- that a wrong tier "silently changes the split percentage, 90% versus 70% of
-- every line, which is the most expensive possible thing to get quietly
-- wrong". So the function refused rather than guessed, which is right.
--
-- But nothing ever said so. The Pricing-tab sync writes a rate row with
-- `risk_tier = coalesce(v_tier, risk_tier)`, so a NULL tier leaves the column
-- as it was — on a new row, NULL. The engine then cannot cost the merchant,
-- records the failure, and the operator sees "no risk level set" on a merchant
-- whose Pricing tab plainly shows one. Every merchant in this CRM is in that
-- state.
--
-- This is the same class of defect Phase 3 fixed elsewhere in this build: "the
-- choice pipeline stored keys but rendered and wrote labels". The residuals
-- port inherited the opposite assumption.
--
-- ── THE FIX MATCHES ON SHAPE, NOT ON A SECOND LIST ──────────────────────────
-- Both sides are normalised the same way — lower-cased, with every run of
-- non-alphanumeric characters collapsed to one space — so 'low_risk',
-- 'Low risk', 'LOW-RISK' and 'low  risk' all resolve to the same tier.
--
-- That is deliberately NOT a hardcoded `'low_risk' -> 'low'` map. The table
-- still owns the vocabulary, renaming a choice is still a data change in one
-- place, and an unrecognised value still returns NULL rather than guessing a
-- tier. What changes is only that the join stops depending on punctuation
-- nobody guaranteed.
--
-- `tier_key` is matched too, so a value already stored in the engine's own
-- vocabulary ('no_program', 'low', 'medium', 'high') resolves as itself. That
-- costs nothing and removes a second way for this to break.
--
-- ── NO BACKFILL HERE, ON PURPOSE ────────────────────────────────────────────
-- Existing rate rows keep their NULL tier. Rewriting them would be asserting a
-- price for months that have already been computed, and the rate tables are
-- dated precisely so that history is not restated. Re-saving a merchant's
-- Pricing tab, or importing the rates sheet, now resolves the tier correctly
-- from this point forward — which is the dated-successor path the module is
-- built around.

begin;

create or replace function public.residual_tier_from_pricing_choice(p_choice text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with want as (
    select btrim(regexp_replace(lower(coalesce(p_choice, '')), '[^a-z0-9]+', ' ', 'g')) as k
  )
  select t.tier_key
    from public.residual_risk_tiers t, want
   where t.deleted_at is null
     and want.k <> ''
     and (
       btrim(regexp_replace(lower(coalesce(t.drawer_option, '')), '[^a-z0-9]+', ' ', 'g')) = want.k
       or btrim(regexp_replace(lower(t.tier_key), '[^a-z0-9]+', ' ', 'g')) = want.k
     )
   order by
     /* A drawer_option match wins over a tier_key match, so a label that
        happens to collide with another tier's key cannot outrank its own. */
     (btrim(regexp_replace(lower(coalesce(t.drawer_option, '')), '[^a-z0-9]+', ' ', 'g')) = want.k) desc
   limit 1;
$$;

comment on function public.residual_tier_from_pricing_choice(text) is
  'Maps a record''s Pricing-tab risk choice to a residual_risk_tiers.tier_key. '
  'Matches drawer_option OR tier_key, both normalised to lower-case with runs '
  'of non-alphanumerics collapsed to one space — because records in this CRM '
  'store the choice KEY (low_risk) while drawer_option holds the LABEL '
  '(Low risk), and the original exact comparison therefore resolved NULL for '
  'every merchant. Still returns NULL for an unrecognised value rather than '
  'guessing: a wrong tier silently changes the split percentage.';

revoke all on function public.residual_tier_from_pricing_choice(text) from public, anon;
grant execute on function public.residual_tier_from_pricing_choice(text)
  to authenticated, service_role;

commit;
