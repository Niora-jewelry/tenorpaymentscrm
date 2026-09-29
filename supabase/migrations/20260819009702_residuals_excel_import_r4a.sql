-- Ported from Daniel Weissman's residuals branch, file
-- `20260823120000_residuals_excel_import_r4a.sql`.
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
-- Residuals R4a — Excel fee-report import
-- ============================================================
--
-- Three things:
--   1. Four attribution columns on residual_lines (root_agent, agent_owner,
--      agent, branch) so the source file's agent hierarchy survives ingest.
--   2. residual_column_mappings — the per-processor, saved column-mapping
--      template (source header -> residual_lines target column).
--   3. commit_residual_excel_import — the ONE atomic write that turns a
--      parsed+mapped file into residual_lines rows and closes the import.
--
-- The PDF half (residual_merchant_volumes, paypal_volume, plan-code rollup)
-- is R4b and is deliberately NOT in this migration.

begin;

-- ============================================================
-- 1. residual_lines — agent attribution columns
-- ============================================================
-- The Sample Fee Item Report carries a four-level agent hierarchy
-- (Root Agent / Agent Owner / Agent / Branch) that had nowhere to land in
-- R1b. These are ATTRIBUTION ONLY: they record who the source file credited
-- for a line. They are NOT calculation inputs — the R5 engine derives splits
-- from pricing and volume, never from these strings. Keeping them out of the
-- calc path is what makes it safe for them to be free text carried verbatim
-- from a vendor file.
--
-- All nullable: 'manual' rows have no source file to carry them, and a
-- processor whose report lacks these columns simply maps nothing to them.

alter table public.residual_lines
  add column if not exists root_agent  text,
  add column if not exists agent_owner text,
  add column if not exists agent       text,
  add column if not exists branch      text;

comment on column public.residual_lines.root_agent is
  'Attribution only, carried verbatim from the source fee report. NOT a calculation input.';
comment on column public.residual_lines.agent_owner is
  'Attribution only, carried verbatim from the source fee report. NOT a calculation input.';
comment on column public.residual_lines.agent is
  'Attribution only, carried verbatim from the source fee report. NOT a calculation input.';
comment on column public.residual_lines.branch is
  'Attribution only, carried verbatim from the source fee report. NOT a calculation input.';

-- ============================================================
-- 2. residual_column_mappings
-- ============================================================
-- GRAIN: one row = one (processor, source column header) -> one
-- residual_lines target column.
--
-- Shape mirrors instantly_field_mappings (source_field -> target_column_key)
-- with two deliberate divergences:
--
--   a) SOFT DELETE. instantly_field_mappings hard-deletes, so its uniques are
--      full. Every deletable entity in this CRM soft-deletes, and a mapping
--      template is exactly the kind of admin config someone will want back
--      after a bad edit. Soft delete forces the uniques to be PARTIAL
--      (filtered to live rows) so a retired mapping does not block its
--      replacement.
--
--   b) A CHECK on target_column. instantly_field_mappings targets the
--      open-ended lead_gen_columns registry, so it cannot constrain its
--      target. residual_lines has a FIXED, typed vocabulary — that is the
--      whole point of R1b's no-jsonb-blob decision — so the set of legal
--      targets is closed and belongs in a CHECK. A typo'd target is then a
--      23514 at config time rather than a silently-dropped column at import
--      time.
--
-- period_id is NOT a legal target. The statement month is resolved from the
-- file's Date column into a residual_periods row by the ingest action; it is
-- never mapped cell-by-cell. Nor are the R5 engine-derived columns
-- (total_income, total_buy_rate, tapdash_net_after_split,
-- additional_income_direct, net_income) — those are computed, and letting a
-- spreadsheet write them would put a vendor file in charge of our own
-- calculation output.

create table if not exists public.residual_column_mappings (
  id                    uuid primary key default gen_random_uuid(),

  processor             text not null
                          check (length(btrim(processor)) between 1 and 100),
  source_column_header  text not null
                          check (length(btrim(source_column_header)) between 1 and 200),
  target_column         text not null
                          check (target_column in (
                            'mid',
                            'merchant_name',
                            'fee_category',
                            'fee_item_name',
                            'item_count',
                            'amount',
                            'buy_rate_per_item',
                            'agent_income',
                            'agent_expense',
                            'net_revenue',
                            'root_agent',
                            'agent_owner',
                            'agent',
                            'branch'
                          )),

  created_at            timestamptz not null default now(),
  created_by_id         uuid references auth.users(id),
  updated_at            timestamptz not null default now(),
  updated_by_id         uuid references auth.users(id),
  deleted_at            timestamptz,
  deleted_by_id         uuid references auth.users(id)
);

-- One live mapping per source header per processor: a header cannot feed two
-- targets.
create unique index if not exists residual_column_mappings_processor_source_unique
  on public.residual_column_mappings (processor, source_column_header)
  where deleted_at is null;

-- One live mapping per target per processor: two headers cannot both claim
-- the same target column (the second would silently overwrite the first).
create unique index if not exists residual_column_mappings_processor_target_unique
  on public.residual_column_mappings (processor, target_column)
  where deleted_at is null;

-- Template load path: "give me every mapping for this processor".
create index if not exists residual_column_mappings_processor
  on public.residual_column_mappings (processor)
  where deleted_at is null;

drop trigger if exists residual_column_mappings_set_updated_at
  on public.residual_column_mappings;
create trigger residual_column_mappings_set_updated_at
  before update on public.residual_column_mappings
  for each row execute function public.tg_set_updated_at();

alter table public.residual_column_mappings enable row level security;

drop policy if exists "residual_column_mappings_select"
  on public.residual_column_mappings;
create policy "residual_column_mappings_select"
  on public.residual_column_mappings
  for select to authenticated
  using (deleted_at is null);

drop policy if exists "residual_column_mappings_insert"
  on public.residual_column_mappings;
create policy "residual_column_mappings_insert"
  on public.residual_column_mappings
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_column_mappings_update"
  on public.residual_column_mappings;
create policy "residual_column_mappings_update"
  on public.residual_column_mappings
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

-- No DELETE policy. Retirement is a soft delete (an UPDATE setting
-- deleted_at), matching every other deletable entity in this schema. Note the
-- project_soft_delete_pattern caveat: because the SELECT policy filters
-- deleted_at is null, that UPDATE must run through the service-role admin
-- client, not the user-context client.

-- ============================================================
-- 3. commit_residual_excel_import
-- ============================================================
-- The single atomic write for an Excel import. Follows the
-- save_campaign_page_* precedent: one SECURITY DEFINER function that owns a
-- multi-statement transaction, so a partial import is impossible.
--
-- SECURITY DEFINER + EXPLICIT AUTH GATE. Definer bypasses RLS, which is the
-- point (the sweep below must soft-delete residual_lines, and the standard
-- SELECT-policy-as-post-update-visibility check would reject that from a user
-- context — see project_soft_delete_pattern). Because RLS is bypassed, the
-- admin gate below is the ONLY thing standing between a marketer and a bulk
-- write. It is not optional and must stay first.
--
-- WHY jsonb_to_recordset WITH AN EXPLICIT TYPE LIST: the numeric columns are
-- the entire reason this table is typed rather than a jsonb blob. The type
-- list is where a JSON number becomes an exact numeric — the cast happens
-- HERE, in SQL, once. JavaScript never adds, rounds, or totals any of these
-- values; it only transports them. numeric(14,6) on buy_rate_per_item is the
-- R2 sub-cent precision decision carried through to bulk import.
--
-- ------------------------------------------------------------
-- SUPERSEDE SCOPE
-- ------------------------------------------------------------
-- Sweep = soft-delete every LIVE residual_lines row belonging to a DIFFERENT
-- import that shares this import's (processor, period_id, source_type).
--
-- Why that scope, and why the obvious phrasing is wrong: the natural framing
-- is "soft-delete the lines of the prior COMPLETED import". But
-- residual_imports carries a partial unique on
-- (processor, period_id, source_type) WHERE status='completed' AND
-- deleted_at IS NULL — so a second import for the same triple can never
-- REACH 'completed' while the first one is live. Under that framing the
-- sweep could never fire at all.
--
-- What actually happens operationally: to re-import a month, an admin
-- soft-deletes the old residual_imports row (dropping it out of the unique
-- index), then uploads again. Soft-deleting the import row does NOT cascade
-- to its lines — they stay live and would double-count against the new
-- import. THAT is the case this sweep exists for, which is why it keys on
-- "different import, same triple" rather than on the superseded import's
-- status. It also mops up any lines left behind by an import that inserted
-- and then failed before completing.
--
-- What the sweep deliberately does NOT touch:
--   * source='manual' lines. residual_lines_provenance_consistent guarantees
--     those have import_id IS NULL, so the join excludes them outright. A
--     hand-entered correction must survive a re-import.
--   * PDF-sourced rows (different source_type).
--   * Another processor's rows for the same month.
--
-- processor and period_id are REQUIRED (guarded below). Without both, the
-- triple is not well-defined, the idempotency index does not apply either,
-- and a sweep keyed on NULLs could delete the wrong month's lines.

create or replace function public.commit_residual_excel_import(
  p_import_id uuid,
  p_period_id uuid,
  p_rows      jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_processor   text;
  v_source_type text;
  v_status      text;
  v_inserted    integer;
begin
  -- Auth gate FIRST. See the header note: definer bypasses RLS.
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to commit a residual import.'
      using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array.'
      using errcode = '22023';
  end if;

  -- Lock the import row for the duration so two concurrent commits of the
  -- same import serialize rather than both inserting.
  select ri.processor, ri.source_type, ri.status
    into v_processor, v_source_type, v_status
    from public.residual_imports ri
   where ri.id = p_import_id
     and ri.deleted_at is null
   for update;

  if not found then
    raise exception 'Residual import % not found.', p_import_id
      using errcode = '22023';
  end if;

  -- Status guard: only a row the ingest action has already moved to
  -- 'processing' may be committed. This is what makes a double-submit a
  -- no-op rather than a double-insert.
  if v_status <> 'processing' then
    raise exception 'Residual import % is in status %, expected processing.',
      p_import_id, v_status
      using errcode = '22023';
  end if;

  if v_source_type <> 'excel' then
    raise exception 'Residual import % has source_type %, expected excel.',
      p_import_id, v_source_type
      using errcode = '22023';
  end if;

  if v_processor is null or p_period_id is null then
    raise exception 'Residual import % needs both a processor and a period.',
      p_import_id
      using errcode = '22023';
  end if;

  -- Pin the resolved period onto the import row in the SAME transaction as
  -- its lines, so the import and its rows can never disagree about which
  -- month they belong to. This also arms the idempotency index, which keys
  -- on period_id.
  update public.residual_imports
     set period_id = p_period_id
   where id = p_import_id;

  -- ---------- supersede sweep (see SUPERSEDE SCOPE above) ----------
  update public.residual_lines rl
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where rl.import_id = ri.id
     and rl.deleted_at is null
     and rl.import_id <> p_import_id
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  -- ---------- insert ----------
  insert into public.residual_lines (
    period_id,
    import_id,
    mid,
    merchant_name,
    fee_category,
    fee_item_name,
    item_count,
    amount,
    buy_rate_per_item,
    agent_income,
    agent_expense,
    net_revenue,
    root_agent,
    agent_owner,
    agent,
    branch,
    source,
    created_by_id,
    updated_by_id
  )
  select
    p_period_id,
    p_import_id,
    r.mid,
    r.merchant_name,
    r.fee_category,
    r.fee_item_name,
    r.item_count,
    r.amount,
    r.buy_rate_per_item,
    r.agent_income,
    r.agent_expense,
    r.net_revenue,
    r.root_agent,
    r.agent_owner,
    r.agent,
    r.branch,
    'excel',
    v_actor,
    v_actor
  from jsonb_to_recordset(p_rows) as r(
    mid                text,
    merchant_name      text,
    fee_category       text,
    fee_item_name      text,
    item_count         numeric(14,4),
    amount             numeric(14,2),
    buy_rate_per_item  numeric(14,6),
    agent_income       numeric(14,2),
    agent_expense      numeric(14,2),
    net_revenue        numeric(14,2),
    root_agent         text,
    agent_owner        text,
    agent              text,
    branch             text
  )
  where r.mid is not null
    and btrim(r.mid) <> '';

  get diagnostics v_inserted = row_count;

  -- ---------- close the import ----------
  -- The status flip is what arms residual_imports' unique-on-completed
  -- index. If a live completed import already holds this
  -- (processor, period_id, source_type), THIS statement raises 23505 and the
  -- whole function rolls back — no lines inserted, no sweep applied. That is
  -- the idempotency guarantee, enforced by the index rather than by a
  -- pre-check that could race.
  update public.residual_imports
     set status       = 'completed',
         row_count    = v_inserted,
         processed_at = now(),
         error_message = null,
         updated_by_id = v_actor
   where id = p_import_id;

  return v_inserted;
end;
$$;

comment on function public.commit_residual_excel_import(uuid, uuid, jsonb) is
  'Atomic commit for an Excel residual import: supersede-sweeps prior lines for the same (processor, period, source_type), bulk-inserts residual_lines with all numeric casting done in SQL, and flips the import to completed. SECURITY DEFINER with an explicit admin gate.';

revoke all on function public.commit_residual_excel_import(uuid, uuid, jsonb) from public;
grant execute on function public.commit_residual_excel_import(uuid, uuid, jsonb) to authenticated;

commit;
