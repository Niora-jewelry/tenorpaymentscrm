-- Ported from Daniel Weissman's residuals branch, file
-- `20260907150000_residuals_signoff_audit_guards_r6a.sql`.
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
-- R6a part 4 of 4 — sign-off, reopen, the transition guard, the two audit
-- tables, and the guards the volume tables never had.
-- ============================================================================
-- ORDERING: applies last. Depends on parts 1-3.

begin;

-- ============================================================
-- 1. residual_period_status_log — gap #17
-- ============================================================
-- Append-only. residual_periods.status is overwritten in place, so
-- updated_by_id records the LAST writer and nothing records the sequence: a
-- period that went ready -> open -> awaiting_volumes was indistinguishable from
-- one that was always awaiting_volumes.
create table if not exists public.residual_period_status_log (
  id            uuid primary key default gen_random_uuid(),
  period_id     uuid not null references public.residual_periods(id),
  from_status   text not null,
  to_status     text not null,
  -- NULL is legitimate and meaningful: a transition written by a trigger on a
  -- service-role connection has no auth.uid(). A sign-off never does — the
  -- sign-off function refuses without an actor.
  actor_id      uuid references auth.users(id),
  source        text not null
                  check (source in ('engine','signoff','invalidation','reopen','system')),
  note          text,
  created_at    timestamptz not null default now(),
  constraint residual_period_status_log_is_a_change
    check (from_status <> to_status)
);

create index if not exists residual_period_status_log_period
  on public.residual_period_status_log (period_id, created_at desc);

alter table public.residual_period_status_log enable row level security;

drop policy if exists "residual_period_status_log_select"
  on public.residual_period_status_log;
create policy "residual_period_status_log_select"
  on public.residual_period_status_log
  for select to authenticated
  using (public.auth_is_admin());

-- No INSERT/UPDATE/DELETE policy. Rows arrive only from the SECURITY DEFINER
-- trigger below, which bypasses RLS. An append-only log with a client-reachable
-- INSERT is a log anyone can forge.

comment on table public.residual_period_status_log is
  'Every change to residual_periods.status, append-only. The column is overwritten in place, so without this a period''s history is a single last-writer stamp.';

-- ============================================================
-- 2. residual_calc_runs — gap #16
-- ============================================================
-- The engine already BUILDS this summary and returns it as jsonb;
-- computePeriodAction hands it to the browser and it is discarded. Storing it
-- costs one INSERT and turns "what did the run on the 9th say" from
-- unanswerable into a SELECT.
--
-- WHY IT IS NOT residual_calc_failures. That table is replaced wholesale each
-- run BY DESIGN, and its comment argues correctly that a stale work item is
-- worse than none. This is the opposite kind of record: the failures table is
-- the operator's QUEUE, this is the run's HISTORY, and a queue that accumulates
-- and a history that is truncated are both wrong.
create table if not exists public.residual_calc_runs (
  id                    uuid primary key default gen_random_uuid(),
  period_id             uuid not null references public.residual_periods(id),

  -- The version the run ATTEMPTED. Note this is not the same as
  -- residual_periods.calculation_version afterwards: a gappy run computes
  -- version N and then disclaims it by leaving the period's column NULL. The
  -- pair (version_attempted, stamped) is what makes that legible; today the
  -- fact is only visible as an asymmetry between two tables nobody joins.
  version_attempted     integer not null,
  stamped               boolean not null,

  processor             text not null,
  registry_id           uuid references public.residual_formula_registries(id),
  registry_label        text,

  status_written        text not null,

  merchants_computed    integer not null default 0,
  merchants_failed      integer not null default 0,
  lines_computed        integer not null default 0,
  lines_failed          integer not null default 0,
  groups_computed       integer not null default 0,
  failures_by_reason    jsonb  not null default '{}'::jsonb,

  -- The whole returned object, verbatim. The typed columns above are what
  -- anyone queries; this is what survives a future change to the summary's
  -- shape without a migration.
  summary               jsonb,

  ran_at                timestamptz not null default now(),
  ran_by_id             uuid references auth.users(id)
);

create index if not exists residual_calc_runs_period
  on public.residual_calc_runs (period_id, ran_at desc);

alter table public.residual_calc_runs enable row level security;

drop policy if exists "residual_calc_runs_select" on public.residual_calc_runs;
create policy "residual_calc_runs_select"
  on public.residual_calc_runs
  for select to authenticated
  using (public.auth_is_admin());

comment on table public.residual_calc_runs is
  'One row per engine run, append-only, storing the summary the engine already builds and currently discards. version_attempted + stamped record the run that computed a version and then disclaimed it - today visible only as an unexplained asymmetry between residual_calc_failures and residual_periods.';

-- ============================================================
-- 3. NORMALISE THE STORED STATUS, THEN NARROW THE CHECK
-- ============================================================
-- After R6a, ready / awaiting_volumes / mismatch are DERIVED
-- (residual_period_state) and must never again be stored. Existing rows carry
-- them because the old engine wrote them: at the time of writing, 2026-05 is
-- 'awaiting_volumes' and 2026-07 is 'ready' — and the second is the bug, a
-- period with zero lines reporting ready because it trivially had no failures.
--
-- Both become 'open', which is now the honest value for each: neither carries a
-- standing assertion that it is fully computed. No period is 'reconciled', so
-- no sign-off is disturbed.
--
-- Done with the transition guard not yet installed, deliberately — this is the
-- one status write in the system's life that is a schema migration rather than
-- a transition, and it is logged as 'system' below.
insert into public.residual_period_status_log
  (period_id, from_status, to_status, source, note)
select p.id, p.status, 'open', 'system',
       'R6a: ready/awaiting_volumes/mismatch became derived; the stored column narrows to open|reconciled.'
  from public.residual_periods p
 where p.deleted_at is null
   and p.status in ('ready','awaiting_volumes','mismatch');

update public.residual_periods
   set status = 'open'
 where deleted_at is null
   and status in ('ready','awaiting_volumes','mismatch');

-- THE CHECK IS NARROWED RATHER THAN LEFT WIDE. Leaving five values legal while
-- only two are reachable would mean the schema described a vocabulary the
-- system no longer has, and the next reader would have to find the trigger to
-- learn that. Narrowing makes the stored column say what it now means: a
-- SIGN-OFF FLAG, not a progress ladder.
alter table public.residual_periods
  drop constraint if exists residual_periods_status_check;
alter table public.residual_periods
  add constraint residual_periods_status_check
  check (status in ('open', 'reconciled'));

comment on column public.residual_periods.status is
  'The SIGN-OFF FLAG, not a progress ladder. Only open and reconciled are storable; ready, awaiting_volumes and mismatch are derived per merchant and rolled up by residual_period_state. Movable only through residual_sign_off_period and residual_reopen_period - a direct UPDATE is refused by tg_residual_periods_status_transition.';

-- ============================================================
-- 4. THE TRANSITION GUARD — gap #19
-- ============================================================
-- Before R6a anyone with the admin role could set status = 'reconciled' with a
-- bare UPDATE. The freeze that protects every line in the month had nothing
-- protecting its own trigger.
--
-- THE MECHANISM: a transaction-local setting, written by the two transition
-- functions with set_config(..., is_local => true) and therefore discarded at
-- COMMIT or ROLLBACK. It cannot leak into another transaction, another session,
-- or a later statement in a rolled-back one. No precedent for this exists in
-- the repo, so it is introduced here with the argument stated.
--
-- WHY NOT HAVE THE GUARD VALIDATE INSTEAD OF REQUIRING A TOKEN. A guard that
-- checked "is every merchant ready?" for itself would let a direct UPDATE
-- succeed whenever the answer happened to be yes — and a sign-off that can
-- happen as a side effect of an UPDATE is not a sign-off. It would also make
-- every write to the column derive verdicts for the whole period inside a
-- per-row BEFORE trigger, which is exactly the cost this design exists to
-- avoid.
--
-- A NON-TRANSITION IS NOT GUARDED. Both the engine and the invalidation trigger
-- include status in their SET lists while leaving the value unchanged; a
-- BEFORE UPDATE OF trigger fires on the column being ASSIGNED, not on it
-- changing. Guarding those would break two working paths to no purpose — a
-- transition guard guards transitions.
create or replace function public.tg_residual_periods_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := current_setting('residuals.status_transition', true);
  v_want  text := new.id::text || ':' || new.status;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status not in ('open', 'reconciled') then
    raise exception
      'residual_periods.status cannot be set to %: the progress states are derived.',
      new.status
      using errcode = '22023',
            hint = 'Read residual_period_state(period_id) instead.';
  end if;

  if v_token is distinct from v_want then
    raise exception
      'residual_periods.status is not directly writable (% -> %).',
      old.status, new.status
      using errcode = '42501',
            hint = 'Use residual_sign_off_period(period_id, note) or residual_reopen_period(period_id, reason).';
  end if;

  return new;
end;
$$;

revoke all on function public.tg_residual_periods_status_transition()
  from public, anon, authenticated, service_role;

drop trigger if exists residual_periods_status_transition
  on public.residual_periods;
create trigger residual_periods_status_transition
  before update of status on public.residual_periods
  for each row execute function public.tg_residual_periods_status_transition();

-- The log is written AFTER, so it records what actually landed rather than what
-- was attempted. Source comes from the same transaction-local token; 'system'
-- is the honest default for a change arriving through neither function.
create or replace function public.tg_residual_periods_status_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src  text := coalesce(current_setting('residuals.status_source', true), 'system');
  v_note text := nullif(current_setting('residuals.status_note', true), '');
begin
  if new.status is distinct from old.status then
    insert into public.residual_period_status_log
      (period_id, from_status, to_status, actor_id, source, note)
    values (new.id, old.status, new.status, auth.uid(),
            case when v_src in ('engine','signoff','invalidation','reopen')
                 then v_src else 'system' end,
            v_note);
  end if;
  return null;
end;
$$;

revoke all on function public.tg_residual_periods_status_log()
  from public, anon, authenticated, service_role;

drop trigger if exists residual_periods_status_log on public.residual_periods;
create trigger residual_periods_status_log
  after update of status on public.residual_periods
  for each row execute function public.tg_residual_periods_status_log();

-- ============================================================
-- 5. residual_sign_off_period — the human act that stores 'reconciled'
-- ============================================================
-- WHY 'reconciled' IS STORED WHILE EVERY OTHER STATE IS DERIVED. The reconciled
-- guard is a per-row BEFORE trigger on residual_lines: it fires once per line of
-- a 197-row import and must answer "is this period frozen" in one index probe.
-- Deriving that answer would mean running the verdict derivation for the whole
-- period inside a trigger, per row. So the freeze reads a stored flag, and the
-- flag is written once, by a person, through this door.
--
-- IT IS ALSO THE TRUER MODEL. Sign-off is not a fact about the numbers — the
-- numbers only make it PERMISSIBLE. It is somebody saying they have looked.
create or replace function public.residual_sign_off_period(
  p_period_id uuid,
  p_note      text default null,
  p_processor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_status text;
  v_month  date;
  v_state  record;
  v_ret    record;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to sign off a residual period.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Signing off a period requires an identified actor.'
      using errcode = '42501',
            hint = 'This function cannot be called on a service-role connection.';
  end if;

  select p.status, p.statement_month into v_status, v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  if v_status = 'reconciled' then
    raise exception 'Statement month % is already signed off.',
      to_char(v_month, 'YYYY-MM')
      using errcode = '22023';
  end if;

  -- STEP 1: retire what the arithmetic has overtaken, BEFORE judging
  -- signability. Running it after would let a month be signed while carrying an
  -- ack that had stopped describing its row — the ack would suppress a mismatch
  -- it no longer matched, and the suppression would then be frozen in.
  select * into v_ret
    from public.residual_retire_resolved_acks(p_period_id, p_processor);

  -- STEP 2: every merchant must be clean, and there must be at least one.
  select * into v_state
    from public.residual_period_state(p_period_id, p_processor);

  if not v_state.signable then
    raise exception
      'Statement month % is not signable: % merchant(s) — % blocked, % awaiting volumes, % with unacknowledged mismatches.',
      to_char(v_month, 'YYYY-MM'), v_state.merchant_count,
      v_state.blocked, v_state.awaiting_volumes, v_state.mismatch
      using errcode = '22023',
            hint = 'Read residual_merchant_states(period_id) for the per-merchant detail. Every mismatch must pass or be acknowledged.';
  end if;

  -- STEP 3: the transition, tokened so the guard admits exactly this one.
  perform set_config('residuals.status_transition',
                     p_period_id::text || ':reconciled', true);
  perform set_config('residuals.status_source', 'signoff', true);
  perform set_config('residuals.status_note', coalesce(btrim(p_note), ''), true);

  update public.residual_periods
     set status = 'reconciled',
         updated_by_id = v_actor
   where id = p_period_id;

  perform set_config('residuals.status_transition', '', true);
  perform set_config('residuals.status_source', '', true);
  perform set_config('residuals.status_note', '', true);

  return jsonb_build_object(
    'period_id',        p_period_id,
    'statement_month',  to_char(v_month, 'YYYY-MM-DD'),
    'status',           'reconciled',
    'merchants',        v_state.merchant_count,
    'acks_retired',     jsonb_build_object('resolved',   v_ret.resolved,
                                           'superseded', v_ret.superseded)
  );
end;
$$;

comment on function public.residual_sign_off_period(uuid, text, text) is
  'A person signs off a statement month. Retires overtaken acknowledgments FIRST, then requires every merchant to derive ready or reconciled and at least one to exist, then stores ''reconciled'' through the transition guard. The one door to that value; a direct UPDATE is refused.';

revoke all on function public.residual_sign_off_period(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_sign_off_period(uuid, text, text)
  to authenticated;

-- ============================================================
-- 6. residual_reopen_period — undoing a sign-off
-- ============================================================
-- Q25 established that reopening is an explicit admin act rather than a side
-- effect. This is that act, and it is deliberately the only way back.
--
-- ACKNOWLEDGMENTS ARE NOT TOUCHED, and the brief's reading is right. An ack
-- records that a person looked at a delta and accepted it; reopening the month
-- does not unmake that. They persist and are re-evaluated under rule 2 exactly
-- as before: if the reopened month is recomputed and the delta is unchanged,
-- the ack suppresses again and the operator is not asked to re-forgive
-- something they already forgave. If the delta moved, the next retirement sweep
-- supersedes it. Clearing them on reopen would destroy work and, worse, would
-- make reopening a destructive act people avoid.
--
-- A REASON IS MANDATORY, for the same reason an ack's is: undoing a sign-off is
-- exactly the kind of act somebody will need explained a year later.
create or replace function public.residual_reopen_period(
  p_period_id uuid,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_status text;
  v_month  date;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to reopen a residual period.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Reopening a period requires an identified actor.'
      using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Reopening a signed-off month requires a reason.'
      using errcode = '22004';
  end if;

  select p.status, p.statement_month into v_status, v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  if v_status <> 'reconciled' then
    raise exception 'Statement month % is not signed off.',
      to_char(v_month, 'YYYY-MM')
      using errcode = '22023';
  end if;

  perform set_config('residuals.status_transition',
                     p_period_id::text || ':open', true);
  perform set_config('residuals.status_source', 'reopen', true);
  perform set_config('residuals.status_note', btrim(p_reason), true);

  update public.residual_periods
     set status = 'open',
         updated_by_id = v_actor
   where id = p_period_id;

  perform set_config('residuals.status_transition', '', true);
  perform set_config('residuals.status_source', '', true);
  perform set_config('residuals.status_note', '', true);

  return jsonb_build_object(
    'period_id',       p_period_id,
    'statement_month', to_char(v_month, 'YYYY-MM-DD'),
    'status',          'open',
    'acks_kept',       (select count(*)
                          from public.residual_verdict_acknowledgments a
                         where a.period_id = p_period_id
                           and a.retired_at is null
                           and a.deleted_at is null)
  );
end;
$$;

comment on function public.residual_reopen_period(uuid, text) is
  'Undoes a sign-off, with a mandatory reason. Acknowledgments are deliberately NOT cleared: an ack records that a person accepted a delta, and reopening the month does not unmake that. They re-evaluate under the same survival rule, so an unchanged delta is not re-forgiven and a changed one is superseded by the next sweep.';

revoke all on function public.residual_reopen_period(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_reopen_period(uuid, text)
  to authenticated;

-- ============================================================
-- 7. THE VOLUME TABLES GET BOTH TRIGGERS — gap #15
-- ============================================================
-- residual_merchant_volumes carried NEITHER the invalidation trigger nor the
-- reconciled guard: only tg_set_updated_at. Volumes could be written into a
-- signed-off month, and changing one did not invalidate the calculation that
-- had read it. Harmless while no rule successfully read a volume; FATAL from
-- the moment step 1 exists, because step 1's entire left-hand operand lives in
-- that table.
--
-- THE COLUMN-LIST SYMMETRY IS THE SAME ONE residual_lines STATES, and it is
-- restated here because it is the rule a future author will need: THE CHANGES
-- THAT INVALIDATE A CALCULATION ARE PRECISELY THE CHANGES A RECONCILED PERIOD
-- FORBIDS. A column added to one list belongs in the other.
--
-- thread_* IS IN NEITHER LIST, matching the set_updated_at trigger's own
-- exclusion: a merchant-link decision is not statement data, and re-adjudicating
-- a link must not invalidate a calculation or be blocked by a freeze. R5b's
-- relink trigger runs on a service-role connection over signed and unsigned
-- months alike, and putting the link columns in these lists would break it.
--
-- residual_plan_volumes gets the same treatment. It is the PDF's per-plan-code
-- detail from which the four buckets were rolled up, so editing it after the
-- fact changes the provenance of a number the engine read, even though the
-- engine does not read this table directly.

drop trigger if exists residual_merchant_volumes_invalidate_calculation_ins
  on public.residual_merchant_volumes;
create trigger residual_merchant_volumes_invalidate_calculation_ins
  after insert on public.residual_merchant_volumes
  for each row execute function public.tg_residual_lines_invalidate_calculation();

drop trigger if exists residual_merchant_volumes_invalidate_calculation_del
  on public.residual_merchant_volumes;
create trigger residual_merchant_volumes_invalidate_calculation_del
  after delete on public.residual_merchant_volumes
  for each row execute function public.tg_residual_lines_invalidate_calculation();

drop trigger if exists residual_merchant_volumes_invalidate_calculation_upd
  on public.residual_merchant_volumes;
create trigger residual_merchant_volumes_invalidate_calculation_upd
  after update of
    period_id, mid, merchant_name,
    amex_volume, vmd_volume, debit_volume, ebt_volume,
    amex_item_count, vmd_item_count, debit_item_count, ebt_item_count,
    stated_total, stated_item_count, reconciled, unmapped_volume, deleted_at
  on public.residual_merchant_volumes
  for each row execute function public.tg_residual_lines_invalidate_calculation();

drop trigger if exists residual_merchant_volumes_guard_reconciled_ins
  on public.residual_merchant_volumes;
create trigger residual_merchant_volumes_guard_reconciled_ins
  before insert on public.residual_merchant_volumes
  for each row execute function public.tg_residual_guard_reconciled_period();

drop trigger if exists residual_merchant_volumes_guard_reconciled_del
  on public.residual_merchant_volumes;
create trigger residual_merchant_volumes_guard_reconciled_del
  before delete on public.residual_merchant_volumes
  for each row execute function public.tg_residual_guard_reconciled_period();

drop trigger if exists residual_merchant_volumes_guard_reconciled_upd
  on public.residual_merchant_volumes;
create trigger residual_merchant_volumes_guard_reconciled_upd
  before update of
    period_id, mid, merchant_name,
    amex_volume, vmd_volume, debit_volume, ebt_volume,
    amex_item_count, vmd_item_count, debit_item_count, ebt_item_count,
    stated_total, stated_item_count, reconciled, unmapped_volume, deleted_at
  on public.residual_merchant_volumes
  for each row execute function public.tg_residual_guard_reconciled_period();

drop trigger if exists residual_plan_volumes_invalidate_calculation_ins
  on public.residual_plan_volumes;
create trigger residual_plan_volumes_invalidate_calculation_ins
  after insert on public.residual_plan_volumes
  for each row execute function public.tg_residual_lines_invalidate_calculation();

drop trigger if exists residual_plan_volumes_invalidate_calculation_del
  on public.residual_plan_volumes;
create trigger residual_plan_volumes_invalidate_calculation_del
  after delete on public.residual_plan_volumes
  for each row execute function public.tg_residual_lines_invalidate_calculation();

drop trigger if exists residual_plan_volumes_invalidate_calculation_upd
  on public.residual_plan_volumes;
create trigger residual_plan_volumes_invalidate_calculation_upd
  after update of
    period_id, mid, plan_code, volume_bucket, amount, item_count, deleted_at
  on public.residual_plan_volumes
  for each row execute function public.tg_residual_lines_invalidate_calculation();

drop trigger if exists residual_plan_volumes_guard_reconciled_ins
  on public.residual_plan_volumes;
create trigger residual_plan_volumes_guard_reconciled_ins
  before insert on public.residual_plan_volumes
  for each row execute function public.tg_residual_guard_reconciled_period();

drop trigger if exists residual_plan_volumes_guard_reconciled_del
  on public.residual_plan_volumes;
create trigger residual_plan_volumes_guard_reconciled_del
  before delete on public.residual_plan_volumes
  for each row execute function public.tg_residual_guard_reconciled_period();

drop trigger if exists residual_plan_volumes_guard_reconciled_upd
  on public.residual_plan_volumes;
create trigger residual_plan_volumes_guard_reconciled_upd
  before update of
    period_id, mid, plan_code, volume_bucket, amount, item_count, deleted_at
  on public.residual_plan_volumes
  for each row execute function public.tg_residual_guard_reconciled_period();

-- ============================================================
-- 8. THE INVALIDATION TRIGGER NARROWS TO THE NEW VOCABULARY
-- ============================================================
-- Its old branch mapped ready|reconciled|mismatch -> open. Two of those three
-- can no longer be stored, and the third is unreachable from here: the
-- reconciled guard is a BEFORE trigger on the same events, so on a signed
-- period the statement is rejected and this AFTER trigger never fires. What is
-- left is the part that always mattered — clearing the standing assertion.
create or replace function public.tg_residual_lines_invalidate_calculation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period uuid := coalesce(new.period_id, old.period_id);
begin
  -- Guarded so a 197-row bulk insert performs ONE write rather than 197.
  --
  -- status is deliberately NOT in the SET list any more. It now holds only
  -- open|reconciled; 'reconciled' cannot be seen from here (the BEFORE guard
  -- rejects first) and 'open' would be a self-assignment that trips the
  -- transition trigger for nothing.
  update public.residual_periods p
     set calculation_version = null
   where p.id = v_period
     and p.calculation_version is not null;

  return null;
end;
$$;

revoke all on function public.tg_residual_lines_invalidate_calculation()
  from public, anon, authenticated, service_role;

commit;

-- ============================================================================
-- 9. THE ENGINE CHANGE — applied as a separate statement, see note
-- ============================================================================
-- compute_residual_period must be replaced, for two reasons:
--
--   (a) IT WOULD NOW RAISE. Its stamp block writes 'ready' or
--       'awaiting_volumes', both of which the narrowed CHECK and the transition
--       guard reject. This is not optional cleanup — without it every compute
--       fails.
--   (b) It is where residual_calc_runs is written and where the retirement
--       sweep runs.
--
-- THE APPLIED MIGRATION CARRIES THE FULL FUNCTION VERBATIM from
-- 20260904140000_residuals_capped_rate_evaluation_r5e.sql — the current live
-- definition — with ONLY the stamp block replaced. It is not reproduced here
-- because a 700-line copy in a design document is a copy that will drift from
-- the original before anybody notices.
--
-- THE REPLACEMENT STAMP BLOCK, verbatim, substituted for everything from
-- "-- ---------- stamp ----------" to the closing of the returned
-- jsonb_build_object:
--
--   -- ---------- stamp ----------
--   -- STATUS IS NO LONGER WRITTEN HERE. R6a made the progress states derived
--   -- (residual_period_state) and narrowed the stored column to a sign-off
--   -- flag. The three values this block used to write — 'ready',
--   -- 'awaiting_volumes' and the 'open' that stood in for a "computed with
--   -- gaps" the vocabulary lacked — are all derived now, and the gap that
--   -- forced the overload is said at merchant grain instead.
--   --
--   -- calculation_version IS STILL STAMPED ONLY ON A CLEAN RUN, unchanged and
--   -- still load-bearing: residual_merchant_rate_is_locked treats a non-null
--   -- version as a dependency, so stamping a gappy run would lock every
--   -- merchant it touched, including the ones whose failure is a rate nobody
--   -- has entered yet.
--   v_clean := not exists (
--     select 1 from public.residual_calc_failures where period_id = p_period_id);
--
--   update public.residual_periods
--      set calculation_version = case when v_clean then v_version else null end,
--          updated_by_id = v_actor
--    where id = p_period_id;
--
--   v_failures := coalesce((
--     select jsonb_object_agg(reason_code, n)
--       from (select reason_code, count(*) n
--               from public.residual_calc_failures
--              where period_id = p_period_id group by 1) x), '{}'::jsonb);
--
--   v_summary := jsonb_build_object(
--     'period_id',           p_period_id,
--     'statement_month',     to_char(v_month, 'YYYY-MM-DD'),
--     'processor',           v_processor,
--     'calculation_version', v_version,
--     'stamped',             v_clean,
--     'registry',            v_reg_label,
--     'merchants_computed',  n_merch_ok,
--     'merchants_failed',    n_merch_fail,
--     'lines_computed',      n_line_ok,
--     'lines_failed',        n_line_fail,
--     'groups_computed',     n_groups,
--     'failures_by_reason',  v_failures
--   );
--
--   -- gap #16: the summary this function has always built and thrown away.
--   insert into public.residual_calc_runs
--     (period_id, version_attempted, stamped, processor, registry_id,
--      registry_label, status_written, merchants_computed, merchants_failed,
--      lines_computed, lines_failed, groups_computed, failures_by_reason,
--      summary, ran_by_id)
--   values
--     (p_period_id, v_version, v_clean, v_processor, v_registry,
--      v_reg_label, 'open', n_merch_ok, n_merch_fail,
--      n_line_ok, n_line_fail, n_groups, v_failures,
--      v_summary, v_actor);
--
--   -- Retirement point 1 of 3 (see residual_retire_resolved_acks). The outputs
--   -- have just moved, so this is exactly when an acknowledgment can stop
--   -- describing its row. Idempotent, so a re-run costs nothing.
--   perform public.residual_retire_resolved_acks(p_period_id, v_processor);
--
--   return v_summary;
--
-- DECLARATIONS ADDED to the function's DECLARE block:
--   v_clean    boolean;
--   v_failures jsonb;
--   v_summary  jsonb;
--
-- NOTE ON THE RETURNED OBJECT: 'status' is dropped and 'stamped' added. The
-- one caller, computePeriodAction, reads summary.status in two places
-- (compute-panel.tsx:150 and :157) — an R6b change, listed in the R6a
-- follow-ups rather than silently left to fail typecheck.
