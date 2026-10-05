-- ============================================================================
-- A Residuals tab on the merchant record.
-- ============================================================================
-- WHY THIS EXISTS. Everything built so far is the admin calculation surface at
-- /admin/residuals: import a fee report, compute a month, reconcile it, sign it
-- off. None of it is reachable from a merchant. Open a merchant in the
-- Residuals display module — which the spec lists as the sixth module, and
-- which `modules` has carried since the seed — and you get the same generic
-- tabs as every other module. What that merchant earned is nowhere.
--
-- The link kernel exists precisely for this. Daniel:
--
--   "What it is for: attaching a residual row to the CRM merchant record it
--    belongs to, so the module can be navigated from the CRM and vice versa."
--
-- The "vice versa" half has had nothing to navigate to until now.
--
-- ── A TAB KIND, NOT A MODULE CHECK ──────────────────────────────────────────
-- No code may name a module (convention 1), so this is NOT "if the module is
-- residuals, show figures". It is a system tab with its own `kind`, exactly
-- like communication, cases, files, logins and statements. The renderer
-- switches on `tabs.kind`; WHICH modules carry it is a row in
-- `module_tab_order`, and adding it to Deals as well would be configuration.
--
-- It is assigned to the residuals module below because that is where the
-- client put residuals. Nothing in the code knows that.
--
-- ── WHO MAY SEE IT ──────────────────────────────────────────────────────────
-- Deliberately NOT decided here, and deliberately not widened.
--
-- Every residual_* table's RLS admits admins only, and every reader function is
-- `security definer` gated on auth_is_admin(). This migration adds no new
-- disclosure path: it creates a tab, and the figures behind it stay
-- admin-gated. A non-admin granted the tab sees a panel saying the figures are
-- admin-only, rather than an empty one — because "there is nothing here" and
-- "you may not see this" must never look the same.
--
-- Opening merchant residual figures to non-admins is a client decision with
-- money on the other side of it, and the spec does not make it. When it does,
-- it is one SECURITY DEFINER reader gated on the tab grant instead of
-- auth_is_admin() — not a change to this migration.

-- ============================================================
-- 1. The enum value
-- ============================================================
-- `tabs.kind` is the enum `tab_kind`, which carries the six system kinds plus
-- custom and freeform. A seventh system kind has to be added to the type
-- before a row can claim it.
--
-- ── WHY THIS IS ITS OWN TRANSACTION ─────────────────────────────────────────
-- PostgreSQL will add an enum value inside a transaction, but it cannot be
-- USED until that transaction commits:
--
--   ERROR: unsafe use of new value "residuals" of enum type tab_kind
--
-- So the ALTER commits by itself, and the insert that references it runs in a
-- second transaction below. A single `begin ... commit` wrapping both would
-- fail on the insert — on a migration that reads as though it should work,
-- which is the kind of failure that gets diagnosed as a broken database.
--
-- `if not exists` makes the ALTER idempotent, which matters because the
-- re-run-on-push hazard this project documents applies here too: an unrecorded
-- migration gets replayed, and a bare ADD VALUE would then fail with
-- "already exists".
--
-- ── APPLYING THIS FILE TAKES TWO ROUND TRIPS ────────────────────────────────
-- Sending the whole file as one query string is not enough, whatever the
-- `begin`/`commit` below say: a client that sends several statements in one
-- message wraps them in an IMPLICIT transaction, so the ALTER has not
-- committed when the insert runs and the insert fails with
--
--   55P04  unsafe use of new value "residuals" of enum type tab_kind
--
-- which is exactly what happened the first time. Split the file at the `begin;`
-- below and send the two halves as separate statements. `supabase db push`
-- does this correctly on its own; a hand-rolled runner has to be told.

alter type public.tab_kind add value if not exists 'residuals';

-- ============================================================
-- 2. The tab, and its place in the module
-- ============================================================

begin;

-- `is_system = true` and `accepts_fields = false`: the panel renders computed
-- figures, so there is nothing for the field editor to place on it. A custom
-- tab would let an admin drag fields onto a surface that cannot show them.
--
-- `key` is 'residual_figures', not 'residuals'. The module's slug is
-- 'residuals', and two different things sharing one string is how a join ends
-- up written against the wrong one.
--
-- `key` is citext, so the existence guard is case-insensitive already.

insert into public.tabs (key, label, kind, is_system, accepts_fields, position)
select 'residual_figures', 'Residuals', 'residuals'::public.tab_kind, true, false, 130
where not exists (select 1 from public.tabs where key = 'residual_figures');

-- Last in the strip. The merchant's own details come first; what they earned
-- is a conclusion drawn from them.
--
-- Guarded so a re-run cannot duplicate the assignment, and so this is a no-op
-- on a database where somebody has already removed the tab from the module by
-- hand — reinstating a deliberate removal would be worse than doing nothing.

insert into public.module_tab_order (module_id, tab_id, position)
select m.id, t.id, 130
  from public.modules m
  join public.tabs t on t.key = 'residual_figures'
 where m.slug = 'residuals'
   and not exists (
     select 1 from public.module_tab_order o
      where o.module_id = m.id and o.tab_id = t.id
   );

commit;
