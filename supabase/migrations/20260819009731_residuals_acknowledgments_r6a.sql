-- Ported from Daniel Weissman's residuals branch, file
-- `20260907130000_residuals_acknowledgments_r6a.sql`.
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

-- ============================================================================
-- R6a part 2 of 4 — the acknowledgment table.
-- ============================================================================
-- ORDERING: applies after part 1. The functions that WRITE this table live in
-- part 3, because they must derive a verdict first and the verdict function is
-- declared there. This file declares the shape and the guards only.
--
-- VERDICTS ARE DERIVED; ACKNOWLEDGMENTS ARE STORED. That split is the whole
-- design. A verdict is a fact about numbers and follows them without being
-- told. An acknowledgment is a human assertion about a number — it has an
-- author, a reason and a moment — and nothing can re-derive it.

begin;

-- ============================================================
-- 1. residual_verdict_acknowledgments
-- ============================================================
-- GRAIN: one row = one person forgiving one step's mismatch on one line or one
-- group, once.
--
-- WHY THE DELTA IS STORED ON THE ACK. This is the load-bearing column and the
-- reason the table can exist at all beside derived verdicts. An ack that
-- recorded only "this row was forgiven" would keep suppressing after the number
-- changed, which is a signed-off figure nobody signed off on. Storing the delta
-- turns rule 2 into a comparison the reader can make: suppress only while the
-- delta on the row is still the delta in this row, within the tolerance in
-- force. R5b's retention branch, stated for a quantity instead of an identity.
--
-- APPEND-ONLY, RETIRED-NOT-DELETED. A retired ack is the record of a decision
-- that was correct when it was made and has since been overtaken. Deleting it
-- would destroy exactly the audit trail spec section 5 asks for. Hard deletion
-- is reserved for the admin recycle-bin purge, which is why deleted_at exists
-- alongside retired_at and means something different: retired = superseded by
-- the arithmetic; deleted = expunged by an administrator.
create table if not exists public.residual_verdict_acknowledgments (
  id                  uuid primary key default gen_random_uuid(),

  -- DENORMALIZED FROM THE TARGET ROW, DELIBERATELY. The reconciled guard is a
  -- per-row BEFORE trigger and must answer "which period is this" in one index
  -- probe; reaching it through line_id or group_id would make every ack write
  -- a two-table join inside a trigger. It is also what lets the retirement
  -- sweep and the sign-off check scope by period without a join.
  period_id           uuid not null references public.residual_periods(id),

  scope               text not null check (scope in ('line','group')),
  line_id             uuid references public.residual_lines(id),
  group_id            uuid references public.residual_line_groups(id),

  step                smallint not null check (step in (1, 2, 3)),

  -- WHAT WAS FORGIVEN. numeric(14,4) matching the tolerance's precision, not
  -- the money columns' (14,2): the comparison between this and a freshly
  -- derived delta must not be decided by a rounding the ack introduced.
  delta_acknowledged  numeric(14,4) not null,

  -- The tolerance that was in force when the ack was written, captured so a
  -- reader can see what "same delta" meant at the time without re-resolving a
  -- dated table. Not used by the suppression test — that uses the tolerance in
  -- force NOW — but a retired ack is unreadable without it.
  tolerance_applied   numeric(14,4) not null check (tolerance_applied >= 0),

  -- The run whose numbers were forgiven. NULLABLE, and the nullability is the
  -- honest part: a gappy run leaves residual_periods.calculation_version NULL
  -- by design, and a mismatch on a partially-computed period is still a real
  -- mismatch somebody may need to forgive. NULL here means "forgiven against a
  -- period carrying no standing assertion that its outputs were current".
  calculation_version integer,

  -- MANDATORY, per the spec. A minimum length because "ok" is not a reason and
  -- an empty-ish string would satisfy NOT NULL while defeating its purpose.
  reason              text not null
                        check (length(btrim(reason)) between 3 and 2000),

  created_at          timestamptz not null default now(),
  -- NOT NULL: an unattributed forgiveness is not an audit record. Every other
  -- residual table allows a null actor because rows arrive from imports and
  -- triggers; an ack only ever arrives from a person.
  created_by_id       uuid not null references auth.users(id),

  -- ---------- retirement (written by the system, not by a human) ----------
  retired_at          timestamptz,
  retired_reason      text
                        check (retired_reason in ('resolved','superseded','withdrawn')),
  -- NULL for the two automatic reasons: nobody performed them. Required for
  -- 'withdrawn', which is a person taking a forgiveness back.
  retired_by_id       uuid references auth.users(id),
  retired_note        text,

  -- ---------- recycle bin only ----------
  deleted_at          timestamptz,
  deleted_by_id       uuid references auth.users(id),

  constraint residual_verdict_acks_scope_shape
    check ((scope = 'line'  and line_id  is not null and group_id is null)
        or (scope = 'group' and group_id is not null and line_id  is null)),

  -- Both operands total, so the equivalence never evaluates to NULL and passes
  -- a CHECK silently — the same care residual_lines_provenance_consistent takes.
  constraint residual_verdict_acks_retirement_shape
    check ((retired_at is null) = (retired_reason is null)),

  constraint residual_verdict_acks_withdrawn_has_actor
    check (retired_reason is distinct from 'withdrawn' or retired_by_id is not null),

  constraint residual_verdict_acks_auto_has_no_actor
    check (retired_reason not in ('resolved','superseded') or retired_by_id is null)
);

-- AT MOST ONE LIVE ACK PER (target, step). Two live acks would both claim to
-- suppress the same verdict and could carry different deltas, so the answer to
-- "is this suppressed" would depend on which row was read first. Made
-- unrepresentable rather than resolved by an ORDER BY.
--
-- coalesce(line_id, group_id) is safe as the key because the scope-shape CHECK
-- guarantees exactly one of them is non-null, and both are uuids from disjoint
-- tables.
create unique index if not exists residual_verdict_acks_live_unique
  on public.residual_verdict_acknowledgments (coalesce(line_id, group_id), step)
  where retired_at is null and deleted_at is null;

-- The suppression join in the verdict function, and the retirement sweep.
create index if not exists residual_verdict_acks_period_live
  on public.residual_verdict_acknowledgments (period_id, step)
  where retired_at is null and deleted_at is null;

-- Full history for one target, retired rows included — what the grid shows
-- when somebody asks why a row is flagged again.
create index if not exists residual_verdict_acks_target
  on public.residual_verdict_acknowledgments (coalesce(line_id, group_id), step, created_at desc)
  where deleted_at is null;

alter table public.residual_verdict_acknowledgments enable row level security;

drop policy if exists "residual_verdict_acks_select"
  on public.residual_verdict_acknowledgments;
create policy "residual_verdict_acks_select"
  on public.residual_verdict_acknowledgments
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

-- INSERT and UPDATE policies exist so the table is reachable at all, but every
-- legitimate write goes through a SECURITY DEFINER function in part 3. The
-- functions capture the delta by DERIVING it; a direct insert could claim any
-- delta it liked, and the unique index is the only thing stopping two.
drop policy if exists "residual_verdict_acks_insert"
  on public.residual_verdict_acknowledgments;
create policy "residual_verdict_acks_insert"
  on public.residual_verdict_acknowledgments
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_verdict_acks_update"
  on public.residual_verdict_acknowledgments;
create policy "residual_verdict_acks_update"
  on public.residual_verdict_acknowledgments
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

-- NO DELETE POLICY. Hard deletion is the admin recycle-bin purge, which runs
-- through an admin client that bypasses RLS. There is no user-context route to
-- destroying an acknowledgment, which is the intent.

comment on table public.residual_verdict_acknowledgments is
  'One person forgiving one comparison step''s mismatch on one line or group, once, with a mandatory reason. Stores the DELTA it forgave: an ack suppresses only while the row''s delta is still that delta within the tolerance in force. Append-only and retired-not-deleted - a retired ack is the record of a decision that was right when it was made.';
comment on column public.residual_verdict_acknowledgments.delta_acknowledged is
  'The signed delta at the moment of forgiveness. The reason this table can coexist with derived verdicts: without it an ack would keep suppressing after the number moved, which is a signed-off figure nobody signed off on.';
comment on column public.residual_verdict_acknowledgments.retired_reason is
  'resolved = the verdict now matches or is exempt, so there is nothing left to forgive. superseded = still a mismatch, but at a different delta than the one forgiven. withdrawn = a person took the forgiveness back. The first two are written by the system path only.';

-- ============================================================
-- 2. THE RECONCILED GUARD — and why acks need NO system exception
-- ============================================================
-- THE BRIEF PROPOSED an exception: reject human acks on a reconciled period,
-- but let the system path write retirements. I disagree, and the disagreement
-- makes the design smaller rather than larger.
--
-- A RECONCILED PERIOD'S DELTAS CANNOT MOVE, so retirement can never become due
-- while it is frozen. Every input a verdict reads is already immobile:
--
--   residual_lines            frozen by tg_residual_guard_reconciled_period
--   residual_line_groups      frozen by the same trigger
--   residual_merchant_volumes frozen by part 4 of this migration set
--   residual_plan_volumes     frozen by part 4
--   the tolerance             frozen by residual_tolerance_is_locked (part 1)
--
-- With all five immobile, a verdict on a reconciled period is a constant, so
-- no ack on it can become 'resolved' or 'superseded'. An exception permitting
-- writes that can never be needed is a hole with no compensating use.
--
-- THE ORDERING THAT MAKES THIS TRUE, and it is the only subtle part: the
-- sign-off function in part 4 runs the retirement sweep BEFORE it sets
-- 'reconciled', while the period is still writable. So a month is never signed
-- while carrying an ack that should already have been retired.
--
-- REUSING THE EXISTING TRIGGER FUNCTION UNCHANGED. tg_residual_guard_reconciled_period
-- reads coalesce(new.period_id, old.period_id), which this table has, and
-- raises naming the statement month with a hint to reopen. Attaching it here
-- rather than writing a near-identical second function means the two can never
-- drift apart, and a future column added to the freeze story is added once.
drop trigger if exists residual_verdict_acks_guard_reconciled_ins
  on public.residual_verdict_acknowledgments;
create trigger residual_verdict_acks_guard_reconciled_ins
  before insert on public.residual_verdict_acknowledgments
  for each row execute function public.tg_residual_guard_reconciled_period();

-- Every mutable column. retired_* is included deliberately: on a reconciled
-- period a retirement is by definition not due, so an attempt to write one is
-- a bug or a hand-edit, and both should stop rather than proceed quietly.
drop trigger if exists residual_verdict_acks_guard_reconciled_upd
  on public.residual_verdict_acknowledgments;
create trigger residual_verdict_acks_guard_reconciled_upd
  before update of
    period_id, scope, line_id, group_id, step,
    delta_acknowledged, tolerance_applied, calculation_version, reason,
    retired_at, retired_reason, retired_by_id, retired_note, deleted_at
  on public.residual_verdict_acknowledgments
  for each row execute function public.tg_residual_guard_reconciled_period();

drop trigger if exists residual_verdict_acks_guard_reconciled_del
  on public.residual_verdict_acknowledgments;
create trigger residual_verdict_acks_guard_reconciled_del
  before delete on public.residual_verdict_acknowledgments
  for each row execute function public.tg_residual_guard_reconciled_period();

-- ============================================================
-- 3. AN ACK DOES NOT INVALIDATE A CALCULATION
-- ============================================================
-- Stated as a comment because the absence of a trigger is the decision, and an
-- absence is invisible to a reader looking for one.
--
-- residual_lines carries tg_residual_lines_invalidate_calculation because
-- changing a stated column falsifies the engine's outputs. Acknowledging a
-- mismatch changes no input to any calculation — it records that a human looked
-- at an output and accepted it. Attaching invalidation here would null the
-- period's calculation_version every time somebody forgave a row, unlock every
-- merchant rate the run had locked, and make a month impossible to sign off by
-- the act of preparing it for sign-off.

commit;
