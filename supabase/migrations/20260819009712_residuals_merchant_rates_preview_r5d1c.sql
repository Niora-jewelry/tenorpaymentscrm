-- Ported from Daniel Weissman's residuals branch, file
-- `20260829150000_residuals_merchant_rates_preview_r5d1c.sql`.
--
-- Mechanical changes only: their role vocabulary
-- (auth_role() in ('admin','super_admin')) becomes our auth_is_admin(),
-- and their service-role test (auth_role() is null) becomes
-- auth.uid() is null. Nothing else in this file was altered.
--
-- The reasoning in the comments below is his and is kept verbatim:
-- it explains why the schema is shaped this way, and rewriting it in
-- my own words would lose the parts I have not yet had to understand.
-- ---------------------------------------------------------------------

-- ============================================================
-- Residuals R5d 1c — an EXACT dry run for the rate importer
-- ============================================================
--
-- The import wizard has to tell the operator, before they commit, how many
-- merchants are new, how many are unchanged, and how many will be superseded
-- — and it has to surface validation errors while they can still fix the file.
--
-- THE OBVIOUS IMPLEMENTATION IS THE WRONG ONE. Re-expressing the validation
-- and the seventeen-field comparison in TypeScript (or in a second SQL
-- function) would put a second copy of both next to the authoritative one.
-- 20260829140000 exists precisely because two copies of that comparison is a
-- shape that drifts, and a preview that disagrees with the commit is worse
-- than no preview: it is a wrong number shown at the exact moment the
-- operator is deciding whether to trust the import.
--
-- SO THE PREVIEW RUNS THE REAL COMMIT AND THROWS THE WRITES AWAY.
--
-- A plpgsql BEGIN ... EXCEPTION block is a SUBTRANSACTION. Raising inside it
-- rolls back everything the block wrote, while plpgsql VARIABLES are not
-- transactional and keep their values across the rollback. So the function
-- calls commit_residual_merchant_rates_import, captures its result into a
-- variable, then raises a private sentinel to discard the rows — and returns
-- the captured counts.
--
-- Three properties follow, and they are the whole point:
--
--   * The preview cannot disagree with the commit, because it IS the commit.
--     There is one implementation of validation and one of the comparison.
--   * A real validation error propagates unchanged — the sentinel handler
--     matches only its own errcode, so 23514 and friends reach the caller with
--     their original message and hint.
--   * Nothing is written. The subtransaction rollback is unconditional; the
--     function is STRICTLY read-only from the caller's point of view.
--
-- WHY NOT SET THE FUNCTION `stable` OR `read only`: it genuinely does write,
-- briefly, inside a subtransaction it then discards. Declaring otherwise would
-- be a lie to the planner and would forbid the very calls it makes. It is
-- VOLATILE and honest about it.
--
-- COST. The write-then-discard takes row locks on the affected merchants for
-- the duration of the call. At 33 merchants that is negligible, and the
-- alternative — a divergent second implementation — is not a cost that shows
-- up in a benchmark.
--
-- Idempotent: create-or-replace only. Nothing else is touched.

begin;

create or replace function public.residual_preview_merchant_rates_import(
  p_effective_from date,
  p_rows           jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_res    jsonb;
  v_locked jsonb;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to preview a merchant rate import.'
      using errcode = '42501';
  end if;

  -- Which merchants in this file would have a LOCKED standing version closed
  -- by the import. Computed BEFORE the dry run, on committed state, so it
  -- reports what an operator would be doing rather than what the discarded
  -- subtransaction did.
  --
  -- Closing a locked version is LEGAL — that is how a used merchant is
  -- repriced, and the guard trigger deliberately leaves effective_to alone.
  -- It is surfaced because it is consequential, not because it is forbidden:
  -- superseding a version that a signed-off month depends on changes what
  -- future recomputes of LATER months will read.
  select coalesce(jsonb_agg(jsonb_build_object(
           'mid', r.mid,
           'effective_from', r.effective_from,
           'effective_to', r.effective_to)), '[]'::jsonb)
    into v_locked
    from public.residual_merchant_rates r
   where r.deleted_at is null
     and r.mid in (
       select regexp_replace(coalesce(e->>'mid',''), '[^0-9]', '', 'g')
         from jsonb_array_elements(p_rows) e
     )
     and (r.effective_to is null or r.effective_to > p_effective_from)
     and public.residual_merchant_rate_is_locked(r.mid, r.effective_from, r.effective_to);

  -- ---------- the dry run ----------
  begin
    v_res := public.commit_residual_merchant_rates_import(
      null::uuid, p_effective_from, p_rows);

    -- Discard the writes. v_res survives: plpgsql variables are not rolled
    -- back with the subtransaction.
    raise exception 'residual_preview_rollback'
      using errcode = 'ZZ001';
  exception
    when sqlstate 'ZZ001' then
      null;  -- expected; the rows are gone and v_res is intact
    -- Anything else is a genuine validation failure and belongs to the
    -- caller, with its own errcode, message and hint preserved.
  end;

  return v_res || jsonb_build_object('locked_versions', v_locked, 'dry_run', true);
end;
$$;

comment on function public.residual_preview_merchant_rates_import(date, jsonb) is
  'Exact dry run of a merchant rate import: calls commit_residual_merchant_rates_import inside a subtransaction and discards the writes, returning its real counts plus any standing versions that are LOCKED. Deliberately not a reimplementation — a preview that can disagree with the commit is a wrong number shown at the moment the operator decides to trust it. Writes nothing; VOLATILE because it genuinely writes inside the subtransaction it throws away.';

revoke all on function public.residual_preview_merchant_rates_import(date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_preview_merchant_rates_import(date, jsonb)
  to authenticated;

commit;
