-- Ported from Daniel Weissman's residuals branch, file
-- `20260907120000_residuals_verdict_reference_r6a.sql`.
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
-- R6a part 1 of 4 — the two dated reference tables the verdict layer reads.
-- ============================================================================
-- ORDERING: this file must apply FIRST. Parts 2-4 reference both tables and
-- both lookup functions declared here.
--
-- Nothing in this file derives a verdict. It declares WHAT a verdict is allowed
-- to forgive (tolerances) and WHICH rows carry a volume (row mappings), both
-- effective-dated, because a verdict on a closed month must keep resolving
-- through the values that were in force when somebody signed it.

begin;

-- ============================================================
-- 1. residual_verdict_tolerances
-- ============================================================
-- GRAIN: one row = one comparison step's tolerance over one date range.
--
-- WHY DATED, AND WHY THIS IS THE WHOLE POINT OF THE TABLE. A tolerance is not
-- a preference, it is part of the arithmetic that produced a sign-off. If the
-- number could be edited in place, changing it would silently re-verdict every
-- month already closed under the old one — a month would stop being reconciled
-- because of an edit nobody connected to it. Dating makes a tolerance change
-- what it actually is: a new row that applies from a date forward.
--
-- WHY PER STEP RATHER THAN ONE GLOBAL NUMBER. The three steps compare
-- quantities of different kinds and magnitudes. Step 1 compares processing
-- volumes that run to six figures; step 3 compares fee-line nets measured in
-- cents. $0.05 against a $463,583.88 volume is a 0.00001% test; $0.05 against a
-- $0.22 net is a 23% one. One number cannot mean the same thing in both places,
-- and pretending it does would make the looser test invisible.
--
-- THE SEEDED VALUE IS 0.05 FOR ALL THREE STEPS, AND STEP 1'S IS A GUESS.
-- See the seed block at the bottom of this file for what is known about each.
create table if not exists public.residual_verdict_tolerances (
  id             uuid primary key default gen_random_uuid(),

  -- 1 = volumes vs amount, 2 = agent expense vs total buy rate,
  -- 3 = net revenue vs tapdash net before split.
  -- smallint + CHECK rather than an enum: the step set is closed at three by
  -- the spec, so there is nothing to extend, and an enum would buy nothing.
  step           smallint not null check (step in (1, 2, 3)),

  -- An ABSOLUTE dollar bound on |delta|. numeric(14,4) rather than (14,2)
  -- because a tolerance finer than a cent is a legitimate thing to want and
  -- storing it at cent precision would silently round it to zero.
  tolerance      numeric(14,4) not null check (tolerance >= 0),

  effective_from date not null
                   check (extract(day from effective_from) = 1),
  -- EXCLUSIVE upper bound. NULL = open-ended. Identical to
  -- residual_buy_rate_schedules and residual_formula_registries.
  effective_to   date
                   check (effective_to is null
                          or extract(day from effective_to) = 1),

  label          text not null
                   check (length(btrim(label)) between 1 and 120),
  notes          text,

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id),

  constraint residual_verdict_tolerances_range_ordered
    check (effective_to is null or effective_to > effective_from)
);

-- Two tolerances covering one step in one month is unrepresentable. Without
-- this the resolver would have to pick, and "whichever sorted first" is not a
-- basis for forgiving money.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'residual_verdict_tolerances_no_overlap'
  ) then
    alter table public.residual_verdict_tolerances
      add constraint residual_verdict_tolerances_no_overlap
      exclude using gist (
        step                                    with =,
        daterange(effective_from, effective_to) with &&
      ) where (deleted_at is null);
  end if;
end$$;

create index if not exists residual_verdict_tolerances_lookup
  on public.residual_verdict_tolerances (step, effective_from desc)
  where deleted_at is null;

drop trigger if exists residual_verdict_tolerances_set_updated_at
  on public.residual_verdict_tolerances;
create trigger residual_verdict_tolerances_set_updated_at
  before update on public.residual_verdict_tolerances
  for each row execute function public.tg_set_updated_at();

alter table public.residual_verdict_tolerances enable row level security;

drop policy if exists "residual_verdict_tolerances_select"
  on public.residual_verdict_tolerances;
create policy "residual_verdict_tolerances_select"
  on public.residual_verdict_tolerances
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_verdict_tolerances_insert"
  on public.residual_verdict_tolerances;
create policy "residual_verdict_tolerances_insert"
  on public.residual_verdict_tolerances
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_verdict_tolerances_update"
  on public.residual_verdict_tolerances;
create policy "residual_verdict_tolerances_update"
  on public.residual_verdict_tolerances
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_verdict_tolerances is
  'The absolute dollar bound on |delta| below which a comparison step counts as a match, per step, over a date range. Dated because a tolerance is part of the arithmetic that produced a sign-off: editing one in place would silently re-verdict every month already closed under the old value.';

-- ============================================================
-- 2. residual_volume_row_mappings — WHICH row carries WHICH volume
-- ============================================================
-- GRAIN: one row = one (formula rule, volume bucket) pair. A fee item carrying
-- two buckets gets two rows; three buckets, three rows. The bucket-sum for a
-- row is the SUM of its mapped buckets on the merchant's volume row.
--
-- THE SHAPE ARGUMENT — WHY THIS HANGS OFF A RULE RATHER THAN BEING ITS OWN
-- DATED TABLE. The brief asked for the argument, and there are two honest
-- options.
--
--   (a) rule_id FK -> residual_formula_rules  [CHOSEN]
--   (b) its own (processor, effective_from, effective_to) table
--
-- The mapping is a statement about the PROCESSOR'S REPORT LAYOUT: "on
-- Maverick's fee report, the Amount column of the Amex OptBlue Fee row carries
-- Amex volume". residual_formula_registries is already exactly that — one
-- processor's report, described over one date range, with fee items matched on
-- exact name and nothing else. Hanging the mapping off a rule inherits all four
-- properties for free: the processor scoping, the dating, the exact-name match
-- key, and — the one that decides it — the guarantee that the two descriptions
-- of a row cannot disagree about whether that row exists. Under (b) a mapping
-- could name a fee item the registry in force has no rule for, and that orphan
-- is representable, silent, and only discoverable by a join nobody writes.
--
-- THE COST OF (a), STATED HONESTLY: a layout change and a pricing change are
-- not the same event, so a processor that moved a volume onto a different row
-- without changing any rate would force a new registry version carrying twenty
-- unchanged rules. That is a real cost. It is smaller than maintaining a second
-- dating vocabulary whose only job is to stay in step with the first one.
--
-- WHY NOT A BARE fee_item_name COLUMN alongside registry_id: rule_id is the
-- same key with referential integrity attached. A mapping for a fee item the
-- registry never had becomes unrepresentable rather than merely unlikely.
create table if not exists public.residual_volume_row_mappings (
  id             uuid primary key default gen_random_uuid(),

  rule_id        uuid not null
                   references public.residual_formula_rules(id),

  -- Same four values, spelled the same way, as residual_merchant_volumes'
  -- column names and residual_plan_volumes.volume_bucket. One vocabulary for
  -- the whole module: the verdict function builds its bucket-sum by matching
  -- this text against those column names, so a fifth spelling would be a
  -- silent zero.
  volume_bucket  text not null
                   check (volume_bucket in
                          ('amex_volume','vmd_volume','debit_volume','ebt_volume')),

  notes          text,

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id)
);

-- One live mapping per (rule, bucket). A duplicate would double that bucket
-- inside the sum and produce a mismatch with no cause visible in the data.
create unique index if not exists residual_volume_row_mappings_unique
  on public.residual_volume_row_mappings (rule_id, volume_bucket)
  where deleted_at is null;

create index if not exists residual_volume_row_mappings_rule
  on public.residual_volume_row_mappings (rule_id)
  where deleted_at is null;

drop trigger if exists residual_volume_row_mappings_set_updated_at
  on public.residual_volume_row_mappings;
create trigger residual_volume_row_mappings_set_updated_at
  before update on public.residual_volume_row_mappings
  for each row execute function public.tg_set_updated_at();

alter table public.residual_volume_row_mappings enable row level security;

drop policy if exists "residual_volume_row_mappings_select"
  on public.residual_volume_row_mappings;
create policy "residual_volume_row_mappings_select"
  on public.residual_volume_row_mappings
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_volume_row_mappings_insert"
  on public.residual_volume_row_mappings;
create policy "residual_volume_row_mappings_insert"
  on public.residual_volume_row_mappings
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_volume_row_mappings_update"
  on public.residual_volume_row_mappings;
create policy "residual_volume_row_mappings_update"
  on public.residual_volume_row_mappings
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_volume_row_mappings is
  'Which volume bucket(s) a fee-report row''s Amount column carries, per formula rule. Step 1 compares residual_lines.amount on a mapped row against the SUM of its mapped buckets on residual_merchant_volumes at (period, mid). Hangs off a rule rather than being independently dated so that the registry and the mapping cannot disagree about which fee items exist.';

-- ============================================================
-- 3. residual_tolerances_for_month — the resolver
-- ============================================================
-- RETURNS ALL THREE STEPS, NOT ONE. A per-step resolver called three times
-- would let a month be covered for steps 2 and 3 and uncovered for step 1, and
-- the caller would discover that on the third call after two had already
-- succeeded. Asking for the whole set makes partial coverage a single loud
-- failure at the top of the verdict function.
--
-- RAISES RATHER THAN RETURNING EMPTY, the same safety rule as
-- residual_buy_rates_for_month and residual_merchant_rates_for_month: a missing
-- tolerance must never read as a zero tolerance, which would fail every
-- comparison that is off by a cent and call it news.
create or replace function public.residual_tolerances_for_month(
  p_month date
)
returns table (step smallint, tolerance numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_n     int;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read verdict tolerances.'
      using errcode = '42501';
  end if;

  if v_month is null then
    raise exception 'residual_tolerances_for_month: p_month is required.'
      using errcode = '22004';
  end if;

  return query
    select t.step, t.tolerance
      from public.residual_verdict_tolerances t
     where t.deleted_at is null
       and t.effective_from <= v_month
       and (t.effective_to is null or t.effective_to > v_month)
     order by t.step;

  get diagnostics v_n = row_count;

  if v_n <> 3 then
    raise exception
      'Verdict tolerances cover % for % of 3 steps; all three are required.',
      to_char(v_month, 'YYYY-MM'), v_n
      using errcode = 'P0002',
            hint = 'Add the missing rows to residual_verdict_tolerances covering this month.';
  end if;
end;
$$;

comment on function public.residual_tolerances_for_month(date) is
  'The tolerance in force for each of the three comparison steps in one statement month. Returns all three or raises: partial coverage discovered on the third of three calls is a worse failure than one loud one, and a missing tolerance must never read as zero.';

revoke all on function public.residual_tolerances_for_month(date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_tolerances_for_month(date)
  to authenticated;

-- ============================================================
-- 4. residual_tolerance_is_locked — and why it must exist
-- ============================================================
-- THE HOLE THIS CLOSES. Everything else in the freeze story protects the
-- period's own rows: the reconciled guard blocks writes to residual_lines and
-- residual_line_groups. But a verdict is derived from those rows AND from a
-- tolerance, and the tolerance lives outside the period. Nothing stopped an
-- admin closing the standing tolerance row and opening a past-dated successor,
-- which would re-verdict every closed month it covered — the exact failure
-- dating exists to prevent, arriving through the back door.
--
-- Modelled on residual_buy_rate_schedule_is_locked, and locked by the same
-- test: a period that is RECONCILED and whose statement month falls in this
-- tolerance's range depends on this number. Note the test is 'reconciled',
-- NOT 'has a calculation_version' — an unsigned month can be re-verdicted
-- freely, because nobody has stood behind its numbers yet.
create or replace function public.residual_tolerance_is_locked(
  p_step smallint,
  p_from date,
  p_to   date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.residual_periods p
     where p.deleted_at is null
       and p.status = 'reconciled'
       and p.statement_month >= p_from
       and (p_to is null or p.statement_month < p_to)
  );
$$;

comment on function public.residual_tolerance_is_locked(smallint, date, date) is
  'True when a RECONCILED period''s statement month falls inside this tolerance''s range. A signed-off month resolved its verdicts through this number, so changing it would un-sign the month from outside. The test is ''reconciled'', not ''computed'': an unsigned month may be re-verdicted freely.';

revoke all on function public.residual_tolerance_is_locked(smallint, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_tolerance_is_locked(smallint, date, date)
  to authenticated;

create or replace function public.tg_residual_tolerance_guard_locked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.residual_tolerance_is_locked(old.step, old.effective_from, old.effective_to) then
    raise exception
      'The step-% tolerance for % to % was used to reconcile a signed-off month and cannot be changed.',
      old.step, old.effective_from, coalesce(old.effective_to::text, 'open')
      using errcode = '42501',
            hint = 'Open a dated successor from a month with no reconciled period, or reopen the affected month first.';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_residual_tolerance_guard_locked()
  from public, anon, authenticated, service_role;

drop trigger if exists residual_verdict_tolerances_guard_locked
  on public.residual_verdict_tolerances;
create trigger residual_verdict_tolerances_guard_locked
  before update of step, tolerance, effective_from, effective_to, deleted_at
  on public.residual_verdict_tolerances
  for each row execute function public.tg_residual_tolerance_guard_locked();

-- ============================================================
-- 5. residual_volume_mapping_coverage — instead of an 'unmapped' verdict
-- ============================================================
-- THE ARGUMENT THE BRIEF ASKED FOR: is a fourth verdict outcome 'unmapped'
-- needed, or does 'exempt' cover it? NEITHER. They are different facts and
-- must not be collapsed —
--
--   exempt   = this comparison does not apply to this row, and that is
--              settled. Nothing is missing.
--   unmapped = this row is not in the mapping. Either it genuinely carries no
--              volume, or the mapping is incomplete and nobody has noticed.
--
-- Collapsing them loses precisely the signal that would catch a new fee item
-- arriving with a volume nobody mapped, which is the same argument the registry
-- makes for raising on an unknown fee_item_name instead of falling back.
--
-- BUT 'unmapped' MUST NOT BE A ROW VERDICT EITHER. Fifteen of the twenty fee
-- items carry no volume, so emitting one per line per period is ~150 rows of
-- noise whose only content is "as expected" — and a signal that fires on every
-- row is not a signal. The house already has the right shape for exactly this:
-- residual_merchant_rate_coverage, residual_reference_coverage and
-- residual_buy_rate_coverage all answer "an invariant no constraint can
-- express" as a separate, cheap, deliberately-consulted report.
--
-- So: the verdict function emits NO step-1 row for an unmapped fee item, and
-- this function answers "is the mapping complete for what this period actually
-- carries". NEVER returns zero rows for a live period with lines; a bad period
-- id raises.
create or replace function public.residual_volume_mapping_coverage(
  p_period_id uuid
)
returns table (
  fee_item_name text,
  line_count    bigint,
  is_mapped     boolean,
  buckets       text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month date;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read volume mapping coverage.'
      using errcode = '42501';
  end if;

  select p.statement_month into v_month
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
    with period_items as (
      select l.fee_item_name as fin, count(*) as n
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
         and l.fee_item_name is not null
       group by l.fee_item_name
    ),
    -- Mappings reachable from ANY live registry, matched by name. Deliberately
    -- not filtered to the registry in force: a fee item mapped in the
    -- predecessor registry and not the current one is a mapping gap worth
    -- seeing, not a row to hide.
    mapped as (
      select ru.fee_item_name as fin,
             array_agg(distinct m.volume_bucket order by m.volume_bucket) as bks
        from public.residual_volume_row_mappings m
        join public.residual_formula_rules ru on ru.id = m.rule_id
       where m.deleted_at is null and ru.deleted_at is null
       group by ru.fee_item_name
    )
    select pi.fin,
           pi.n,
           (mp.bks is not null),
           mp.bks
      from period_items pi
      left join mapped mp on mp.fin = pi.fin
     order by (mp.bks is not null), pi.fin;
end;
$$;

comment on function public.residual_volume_mapping_coverage(uuid) is
  'Every fee item this period''s lines actually carry, and whether a volume-row mapping covers it. The reason there is no ''unmapped'' verdict outcome: an unmapped row is a question about the MAPPING, not about that row''s money, and a signal that fires on 15 of 20 fee items every period is not a signal.';

revoke all on function public.residual_volume_mapping_coverage(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_volume_mapping_coverage(uuid)
  to authenticated;

-- ============================================================
-- 6. SEED — tolerances
-- ============================================================
-- FLOOR SENTINEL 2000-01-01, matching the pre-changeover registry and the
-- MAVERICK buy-rate schedule, so every month that exists is covered.
--
-- STEPS 2 AND 3 — 0.05, CHOSEN KNOWINGLY (Q36 = B). The measured consequence
-- is recorded rather than buried: in the 63-row May sample, ±0.05 forgives
-- three of the nineteen step-3 deltas — the two one-cent rows that come from
-- the PROCESSOR'S OWN rounding in the source file (0.30 - 0.08 = 0.22 against a
-- stated 0.23, and 0.50 - 0.03 = 0.47 against 0.48), AND Orlando's Merchant
-- Deposit row at 0.04, which is NOT rounding: it is a genuine 0.005/item rate
-- variance (9 items at an implied 0.0300 against a template 0.025). ±0.01 would
-- have caught that one. The looser bound was chosen with that trade in hand.
--
-- STEP 1 — 0.05 IS A PLACEHOLDER AND SHOULD BE TREATED AS UNKNOWN. No
-- statement/report pair has ever been measured: the 197 fee lines are 2026-05
-- and the only volume row is 2026-07, so zero (period, mid) pairs carry both
-- and step 1 has never once been evaluated against real data. The internal
-- fee-report arithmetic that motivated the mapping (BIN + OptBlue = Cash Disc
-- exactly on 6 MIDs; Interchange = Cash Disc within a cent on 12 of 13) is a
-- comparison between REPORT ROWS, not between a report row and a STATEMENT
-- volume, which is what step 1 actually tests. Revisit this number the first
-- time one merchant-month carries both artifacts.
insert into public.residual_verdict_tolerances
  (step, tolerance, effective_from, effective_to, label, notes)
values
  (1, 0.0500, date '2000-01-01', null,
   'Step 1 — volumes vs amount (provisional)',
   'PROVISIONAL. No statement/report pair has ever been measured, so the right number is unknown. Set equal to steps 2 and 3 only so the resolver is covered. Revisit on the first merchant-month carrying both a fee report and a PDF statement.'),
  (2, 0.0500, date '2000-01-01', null,
   'Step 2 — agent expense vs total buy rate',
   'Q36 = B. Measured against the May 2026 sample; see the step-3 note for what 0.05 forgives that 0.01 would not.'),
  (3, 0.0500, date '2000-01-01', null,
   'Step 3 — net revenue vs tapdash net before split',
   'Q36 = B, chosen knowingly. Forgives the two processor-rounding cents AND Orlando''s real 0.04 rate variance (9 items, implied 0.0300 vs template 0.025), which +/-0.01 would have caught.')
on conflict do nothing;

-- ============================================================
-- 7. SEED — volume row mappings, BOTH registries
-- ============================================================
-- BOTH REGISTRIES, not just the live one — the same argument 84aef75 made for
-- the chargeback rule. The report's LAYOUT did not change at the June
-- monthly-fee changeover; only rule #2 did. Seeding only the current registry
-- would make a recomputed pre-June month report every volume row as unmapped —
-- a gap caused by the seed rather than by the data.
--
-- THE MAPPING, AND THE ONE CONFLICT IN IT:
--
--   Amex OptBlue Fee            -> amex
--   BIN Sponsorship Fees        -> vmd + debit
--   Cash Disc/Surcharge Program -> amex + vmd + debit
--   Interchange                 -> amex + vmd + debit
--   EBT Authorization Fee       -> ebt
--
-- EBT IS DELIBERATELY OUTSIDE THE BIN AND CASH DISC SUMS, AND THE WORKBOOK
-- DISAGREES. The user confirms EBT prices off VMD rates but reports on its own
-- line; the workbook's data-entry marks read as though EBT belongs inside the
-- bucket sums. The arithmetic in the sample supports exclusion: on MID
-- 201100269662, BIN 23,500.68 + OptBlue 7,725.58 = Cash Disc 31,226.26 EXACTLY,
-- and that identity breaks by 383.65 the moment EBT is folded into either side.
-- Recorded here rather than resolved, because the sample settles the fee
-- report's INTERNAL consistency and step 1 is a test against the STATEMENT.
-- THE FIRST OVERLAPPING MERCHANT-MONTH ARBITRATES.
--
-- Interchange and Cash Disc carry the SAME three buckets and each gets its own
-- step-1 verdict. That is intended: they are two independent assertions about
-- the same quantity, and the sample shows them agreeing to the cent on 12 of
-- the 13 MIDs carrying both (the exceptions are 201100272922 at one cent and
-- Orlando 201100169797 at 42,251.18 — the MID already parked in spec 8.7).
insert into public.residual_volume_row_mappings (rule_id, volume_bucket, notes)
select ru.id, v.bucket, v.note
  from public.residual_formula_rules ru
  join public.residual_formula_registries reg on reg.id = ru.registry_id
  join (values
    ('Amex OptBlue Fee',            'amex_volume',  'Amex volume the OptBlue fee is assessed on.'),
    ('BIN Sponsorship Fees',        'vmd_volume',   'BIN is assessed on VMD + debit; Amex is not in it.'),
    ('BIN Sponsorship Fees',        'debit_volume', 'BIN is assessed on VMD + debit; Amex is not in it.'),
    ('Cash Disc/Surcharge Program', 'amex_volume',  'Cash Disc spans all three card buckets. EBT excluded - see header.'),
    ('Cash Disc/Surcharge Program', 'vmd_volume',   'Cash Disc spans all three card buckets. EBT excluded - see header.'),
    ('Cash Disc/Surcharge Program', 'debit_volume', 'Cash Disc spans all three card buckets. EBT excluded - see header.'),
    ('Interchange',                 'amex_volume',  'Same three buckets as Cash Disc; an independent second assertion.'),
    ('Interchange',                 'vmd_volume',   'Same three buckets as Cash Disc; an independent second assertion.'),
    ('Interchange',                 'debit_volume', 'Same three buckets as Cash Disc; an independent second assertion.'),
    ('EBT Authorization Fee',       'ebt_volume',   'Prices off VMD rates but reports its own volume on its own line.')
  ) as v(fee_item, bucket, note) on v.fee_item = ru.fee_item_name
 where ru.deleted_at is null
   and reg.deleted_at is null
   and reg.processor = 'MAVERICK'
on conflict do nothing;

-- The seed must have landed on BOTH registries: 10 pairs x 2 registries = 20.
-- Asserted rather than assumed, because an INSERT ... SELECT that matches
-- nothing succeeds silently, and a mapping that never seeded is
-- indistinguishable from a fee item that carries no volume.
do $$
declare
  v_n int;
  v_regs int;
begin
  select count(*), count(distinct ru.registry_id)
    into v_n, v_regs
    from public.residual_volume_row_mappings m
    join public.residual_formula_rules ru on ru.id = m.rule_id
   where m.deleted_at is null;

  if v_n <> 20 or v_regs <> 2 then
    raise exception
      'Volume row mapping seed landed % rows across % registries; expected 20 across 2.',
      v_n, v_regs;
  end if;
end$$;

commit;
