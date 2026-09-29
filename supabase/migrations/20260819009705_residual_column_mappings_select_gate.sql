-- Ported from Daniel Weissman's residuals branch, file
-- `20260825130000_residual_column_mappings_select_gate.sql`.
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
-- Residuals R5a follow-up — close the last ungated residual SELECT
-- ============================================================
--
-- 20260825120000_residuals_plan_volumes_r5a.sql section 6 tightened SELECT to
-- admin/super_admin on residual_periods, residual_imports, residual_lines and
-- residual_merchant_volumes, and explicitly left residual_column_mappings out
-- on the grounds that it holds no merchant data and no money.
--
-- That reasoning is correct about the CONTENT and wrong about the RULE. A gate
-- with one documented exception reads, to the next person adding a residual
-- table, as a gate that is optional. Six residual tables with five gated is a
-- pattern nobody can apply without first reading a paragraph of prose; six
-- with six is a pattern that applies itself.
--
-- WHY THIS IS SAFE HERE AND NOT ON residual_plan_code_buckets. That table is
-- the deliberate exception and MUST stay open: residual_derive_plan_rollup is
-- SECURITY INVOKER and LEFT JOINs it, so a role gate would make every join
-- miss for a non-admin caller and return reconciled=false — a wrong ANSWER
-- rather than a permission error. residual_column_mappings has no such
-- hazard:
--
--   * no SECURITY INVOKER function joins it (verified: neither
--     residual_derive_plan_rollup nor either commit RPC references it; both
--     commit RPCs are SECURITY DEFINER and bypass RLS regardless);
--   * every read is inside app/(app)/admin/residuals/, behind the admin
--     layout's requireSuperAdmin() and each action's own gateAdmin();
--   * its INSERT and UPDATE policies are ALREADY auth_role() in
--     ('admin','super_admin'), so SELECT was the odd one out — a non-admin
--     could read a mapping template they could never have written.
--
-- So the worst case is a permission error on a path no non-admin can reach,
-- not a silently different answer.
--
-- INSERT and UPDATE are untouched. Only SELECT changes.

drop policy if exists "residual_column_mappings_select"
  on public.residual_column_mappings;
create policy "residual_column_mappings_select"
  on public.residual_column_mappings
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

-- ------------------------------------------------------------
-- MIGRATION SAFETY
-- ------------------------------------------------------------
-- Policy-only, idempotent (drop-if-exists then create), no DDL, no data
-- change, instantly reversible by re-creating the policy with
-- `using (deleted_at is null)`.
--
-- Post-apply confirmation — every residual table's SELECT gate in one row set.
-- Expect auth_role() in the qual for all six EXCEPT
-- residual_plan_code_buckets, which is the documented exception:
--
--   select tablename, policyname, qual
--     from pg_policies
--    where schemaname = 'public'
--      and tablename like 'residual%'
--      and cmd = 'SELECT'
--    order by tablename;
