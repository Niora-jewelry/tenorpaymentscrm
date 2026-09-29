-- Ported from Daniel Weissman's residuals branch, file
-- `20260820120000_residuals_foundation_r1b.sql`.
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

-- Residuals arc — Slice R1b: schema foundation (STRICTLY ADDITIVE).
--
-- Creates the storage substrate for the Residuals module: statement
-- periods, the fee-line grain, PDF-sourced merchant volumes, the upload
-- job record, and a private bucket for original-file retention.
--
-- SCOPE BOUNDARIES (locked with the user before this migration was written):
--   - NO calculations. Storage only. Every derived figure is a nullable
--     column the R5 engine fills; nothing is computed here or by trigger.
--   - MID uniqueness is DEFERRED to R2. This migration does not touch
--     lead_gen_threads, lead_gen_threads.column_data, or lead_gen_columns,
--     and creates no index on any drawer field. mid is a plain text
--     column on the financial tables — a LOOSE link by text match, never
--     an FK into the drawer EAV.
--   - No app code reads these tables yet; type regen is purely additive.
--
-- MONEY RULE (non-negotiable): every dollar amount is numeric(14,2) and
-- every rate is numeric(14,6). No float / double precision anywhere in
-- this file. numeric(14,2) tops out near 999,999,999,999.99 which is far
-- beyond any plausible monthly residual, and it is EXACT — sums must
-- happen in SQL over these columns, never by accumulating JS floats
-- (a JS sum of 19169.58-style values yields 19169.58000000000175).
--
-- RATE PRECISION: buy rates in the source data look like 0.033816 —
-- six decimal places. numeric(14,6) holds that exactly. If rates with
-- more than 6 dp ever appear, widen the scale BEFORE real data lands;
-- widening later rewrites a financial table.
--
-- PERIOD RULE: a statement month is a CALENDAR fact, not an instant.
-- Stored as a plain date pinned to the 1st of the month, guarded by a CHECK.
-- Chosen over text 'YYYY-MM' because date sorts, compares, and does
-- interval arithmetic natively (month N-1 lookups, range scans) with no
-- parsing, and it cannot hold '2026-13'. timestamptz is explicitly wrong
-- here: SheetJS serializes dates against the runtime timezone, so the
-- same file parsed locally vs on Vercel yields different instants. We
-- normalize to a calendar date at ingest; the schema must not be able to
-- represent anything finer.
--
-- Idempotent: re-runnable (if-not-exists / drop-and-readd guards throughout).

begin;

-- ============================================================
-- 1. residual_periods
-- ============================================================
-- One row per statement month. The month is the organizing unit for
-- every other table here.
--
-- status vocabulary: 'open' is the initial neutral state so the row does
-- not presume which artifact arrives first (an Excel fee report or a PDF
-- volume statement). The rest track the month toward a reconciled close:
--   open             — period exists, nothing loaded yet
--   awaiting_volumes — fee lines loaded, PDF volumes still missing
--   ready            — both artifacts present, calc engine can run
--   reconciled       — computed totals agree with the statement
--   mismatch         — computed totals disagree; needs human review
-- Deliberately text + CHECK rather than a pg enum: enums require a
-- migration to extend, and this vocabulary will move in R3/R5.
--
-- calculation_version: scaffolding, unused until R5. NULL means "never
-- computed". This is what disambiguates a NULL derived column on
-- residual_lines between "not yet computed" and "computed as nothing".
create table if not exists public.residual_periods (
  id                   uuid primary key default gen_random_uuid(),
  statement_month      date not null
                         check (extract(day from statement_month) = 1),
  status               text not null default 'open'
                         check (status in (
                           'open','awaiting_volumes','ready','reconciled','mismatch'
                         )),
  calculation_version  integer,
  notes                text,
  created_at           timestamptz not null default now(),
  created_by_id        uuid references auth.users(id),
  updated_at           timestamptz not null default now(),
  updated_by_id        uuid references auth.users(id),
  deleted_at           timestamptz,
  deleted_by_id        uuid references auth.users(id)
);

-- One live period per calendar month (house idiom: partial unique index
-- on an expression, filtered to live rows).
create unique index if not exists residual_periods_statement_month_unique
  on public.residual_periods (statement_month)
  where deleted_at is null;

create index if not exists residual_periods_status
  on public.residual_periods (status)
  where deleted_at is null;

drop trigger if exists residual_periods_set_updated_at on public.residual_periods;
create trigger residual_periods_set_updated_at
  before update on public.residual_periods
  for each row execute function public.tg_set_updated_at();

alter table public.residual_periods enable row level security;

drop policy if exists "residual_periods_select" on public.residual_periods;
create policy "residual_periods_select"
  on public.residual_periods
  for select to authenticated
  using (deleted_at is null);

drop policy if exists "residual_periods_insert" on public.residual_periods;
create policy "residual_periods_insert"
  on public.residual_periods
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_periods_update" on public.residual_periods;
create policy "residual_periods_update"
  on public.residual_periods
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

-- ============================================================
-- 2. residual_imports
-- ============================================================
-- One row per uploaded file. Mirrors the lead_lists status machine
-- exactly (pending -> processing -> completed | failed, with
-- error_message / row_count / processed_at), because that machine is
-- already proven in this codebase and the ingest flow will mirror it:
-- INSERT this row first, upload the file to storage second (the bucket
-- policy below depends on that ordering), parse third.
--
-- Declared BEFORE residual_lines so the provenance FK on lines can
-- reference it.
--
-- processor: which processor's statement this file is (e.g. 'TSYS',
-- 'Fiserv'). Lives HERE rather than on residual_periods because a single
-- statement month legitimately spans multiple processors — one period,
-- many imports. Free text for now; R4 can promote it to a preset.
create table if not exists public.residual_imports (
  id                 uuid primary key default gen_random_uuid(),
  period_id          uuid references public.residual_periods(id),
  processor          text,
  source_type        text not null
                       check (source_type in ('excel','pdf')),
  status             text not null default 'pending'
                       check (status in ('pending','processing','completed','failed')),
  error_message      text,
  row_count          integer,
  processed_at       timestamptz,
  original_filename  text,
  size_bytes         bigint,
  storage_path       text,
  created_at         timestamptz not null default now(),
  created_by_id      uuid references auth.users(id),
  updated_at         timestamptz not null default now(),
  updated_by_id      uuid references auth.users(id),
  deleted_at         timestamptz,
  deleted_by_id      uuid references auth.users(id)
);

-- IDEMPOTENCY GUARD — the "re-uploading a month is detectable, not
-- silently duplicated" rule, designed in from migration 1.
--
-- Grain: (processor, period_id, source_type). period_id is used instead
-- of a denormalized statement_month column because residual_periods
-- already enforces one live period per month, so period_id and
-- statement_month are 1:1 — indexing the FK keeps a single source of
-- truth and removes any chance of the two disagreeing.
--
-- Filtered to status = 'completed' on purpose: a failed or in-flight
-- import must NOT block a retry of the same month. Only a SUCCESSFUL
-- second load of the same processor+month+artifact collides, which is
-- exactly the duplicate we want surfaced. Resolving that collision
-- (replace the prior import vs reject the new file) is a product
-- decision surfaced in R4; at the DB layer it simply cannot happen
-- silently.
create unique index if not exists residual_imports_processor_period_unique
  on public.residual_imports (processor, period_id, source_type)
  where deleted_at is null
    and status = 'completed'
    and processor is not null
    and period_id is not null;

create index if not exists residual_imports_period
  on public.residual_imports (period_id)
  where deleted_at is null;

create index if not exists residual_imports_status
  on public.residual_imports (status, created_at desc)
  where deleted_at is null;

drop trigger if exists residual_imports_set_updated_at on public.residual_imports;
create trigger residual_imports_set_updated_at
  before update on public.residual_imports
  for each row execute function public.tg_set_updated_at();

alter table public.residual_imports enable row level security;

drop policy if exists "residual_imports_select" on public.residual_imports;
create policy "residual_imports_select"
  on public.residual_imports
  for select to authenticated
  using (deleted_at is null);

drop policy if exists "residual_imports_insert" on public.residual_imports;
create policy "residual_imports_insert"
  on public.residual_imports
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_imports_update" on public.residual_imports;
create policy "residual_imports_update"
  on public.residual_imports
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

-- ============================================================
-- 3. residual_lines
-- ============================================================
-- GRAIN: one row = one fee line item, for one MID, in one statement
-- month. This is the Tab-2 grid grain.
--
-- Every column is EXPLICITLY TYPED. No jsonb blob. The lead-gen
-- column_data precedent is a known defect for exactly this use case:
-- values are stored loosely and coerced at render, its inferColumnType
-- heuristic cannot even return 'number', and anything that QUERIES the
-- blob silently misses values. Financial columns must be real typed
-- columns so SUM() is exact and indexable.
--
-- mid is TEXT, deliberately not an FK. It is a loose link matched by
-- text against the Pricing drawer's MID field, which R2 introduces.
-- merchant_name is display-only denormalization carried from the source
-- file; it is NOT the system of record for merchant naming.
--
-- import_id: provenance. Nullable because source='manual' rows have no
-- file behind them. This is what lets R4 implement replace-semantics
-- ("soft-delete every line from the superseded import") without
-- guessing which rows came from which upload.
create table if not exists public.residual_lines (
  id                        uuid primary key default gen_random_uuid(),
  period_id                 uuid not null references public.residual_periods(id),
  import_id                 uuid references public.residual_imports(id),

  -- Identity / grouping (loose link, see note above)
  mid                       text not null,
  merchant_name             text,

  -- Source-file descriptive columns
  fee_category              text,
  fee_item_name             text,

  -- Excel-sourced measures.
  -- item_count is numeric(14,4), not integer, and is named item_count
  -- rather than "count" to avoid colliding with the aggregate function
  -- name in ad-hoc queries. See the R1b recommendations for why numeric.
  item_count                numeric(14,4),
  amount                    numeric(14,2),
  buy_rate_per_item         numeric(14,6),
  agent_income              numeric(14,2),
  agent_expense             numeric(14,2),
  net_revenue               numeric(14,2),

  -- Engine-owned derived columns. Written by the R5 calculation engine,
  -- NULL until then. Read NULL here together with
  -- residual_periods.calculation_version: a NULL calculation_version on
  -- the parent period means "never computed", which is what
  -- distinguishes an uncomputed row from a computed-to-null one.
  total_income              numeric(14,2),
  total_buy_rate            numeric(14,2),
  tapdash_net_after_split   numeric(14,2),
  additional_income_direct  numeric(14,2),
  net_income                numeric(14,2),

  source                    text not null default 'excel'
                              check (source in ('excel','pdf','manual')),

  created_at                timestamptz not null default now(),
  created_by_id             uuid references auth.users(id),
  updated_at                timestamptz not null default now(),
  updated_by_id             uuid references auth.users(id),
  deleted_at                timestamptz,
  deleted_by_id             uuid references auth.users(id),

  -- PROVENANCE CONSISTENCY: a manual row has no file behind it, and a
  -- file-sourced row must name its import. Stated as an equivalence so
  -- BOTH contradictions are rejected: a 'manual' row carrying an
  -- import_id, and an 'excel'/'pdf' row with a null import_id.
  -- Without this, R4's replace-sweep ("soft-delete every line from the
  -- superseded import") behaves inconsistently — orphaned file-sourced
  -- rows would survive a replace they should not have survived.
  -- Both operands are total: source is NOT NULL and IS NULL yields a
  -- boolean, so the equivalence never evaluates to NULL (which would
  -- pass a CHECK silently).
  constraint residual_lines_provenance_consistent
    check ((source = 'manual') = (import_id is null))
);

-- Primary access path: the Tab-2 grid groups fee lines by MID within a
-- month.
create index if not exists residual_lines_period_mid
  on public.residual_lines (period_id, mid)
  where deleted_at is null;

-- Cross-month history for a single merchant.
create index if not exists residual_lines_mid
  on public.residual_lines (mid)
  where deleted_at is null;

-- Provenance sweep: "every line from this import" (R4 replace-semantics).
create index if not exists residual_lines_import
  on public.residual_lines (import_id)
  where deleted_at is null;

drop trigger if exists residual_lines_set_updated_at on public.residual_lines;
create trigger residual_lines_set_updated_at
  before update on public.residual_lines
  for each row execute function public.tg_set_updated_at();

alter table public.residual_lines enable row level security;

drop policy if exists "residual_lines_select" on public.residual_lines;
create policy "residual_lines_select"
  on public.residual_lines
  for select to authenticated
  using (deleted_at is null);

drop policy if exists "residual_lines_insert" on public.residual_lines;
create policy "residual_lines_insert"
  on public.residual_lines
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_lines_update" on public.residual_lines;
create policy "residual_lines_update"
  on public.residual_lines
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

-- ============================================================
-- 4. residual_merchant_volumes
-- ============================================================
-- GRAIN: one row = one MID, one statement month. PDF-sourced processing
-- volumes.
--
-- These live in their OWN table rather than as columns on residual_lines
-- because the grain genuinely differs: a MID has ONE set of monthly
-- volumes but MANY fee lines. Repeating volumes across every fee line
-- would (a) duplicate the same figure N times with no single writer and
-- (b) make the obvious query SUM(amex_volume) silently wrong by a factor
-- of the line count. That is a correctness argument, not a normalization
-- preference.
--
-- statement_month is intentionally NOT stored here; it is derived through
-- period_id. Storing it twice invites the two copies disagreeing.
--
-- All four volumes are dollar amounts, so numeric(14,2) like every other
-- money column in this file.
create table if not exists public.residual_merchant_volumes (
  id             uuid primary key default gen_random_uuid(),
  period_id      uuid not null references public.residual_periods(id),
  import_id      uuid references public.residual_imports(id),

  mid            text not null,
  merchant_name  text,

  amex_volume    numeric(14,2),
  vmd_volume     numeric(14,2),
  debit_volume   numeric(14,2),
  ebt_volume     numeric(14,2),

  -- Volumes carry the same provenance discipline as residual_lines.
  -- Narrower vocabulary than lines: volumes never originate from the
  -- Excel fee report, so the only two origins are the PDF statement and
  -- hand entry. Manual entry is a real case, not a hypothetical — it is
  -- exactly what a period sitting in 'awaiting_volumes' needs when the
  -- PDF is missing or unparseable.
  source         text not null default 'pdf'
                   check (source in ('pdf','manual')),

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id),

  -- Same equivalence as residual_lines_provenance_consistent.
  constraint residual_merchant_volumes_provenance_consistent
    check ((source = 'manual') = (import_id is null))
);

-- Exactly one live volume row per MID per period — this IS the grain,
-- enforced rather than assumed.
create unique index if not exists residual_merchant_volumes_period_mid_unique
  on public.residual_merchant_volumes (period_id, mid)
  where deleted_at is null;

create index if not exists residual_merchant_volumes_mid
  on public.residual_merchant_volumes (mid)
  where deleted_at is null;

create index if not exists residual_merchant_volumes_import
  on public.residual_merchant_volumes (import_id)
  where deleted_at is null;

drop trigger if exists residual_merchant_volumes_set_updated_at
  on public.residual_merchant_volumes;
create trigger residual_merchant_volumes_set_updated_at
  before update on public.residual_merchant_volumes
  for each row execute function public.tg_set_updated_at();

alter table public.residual_merchant_volumes enable row level security;

drop policy if exists "residual_merchant_volumes_select"
  on public.residual_merchant_volumes;
create policy "residual_merchant_volumes_select"
  on public.residual_merchant_volumes
  for select to authenticated
  using (deleted_at is null);

drop policy if exists "residual_merchant_volumes_insert"
  on public.residual_merchant_volumes;
create policy "residual_merchant_volumes_insert"
  on public.residual_merchant_volumes
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_merchant_volumes_update"
  on public.residual_merchant_volumes;
create policy "residual_merchant_volumes_update"
  on public.residual_merchant_volumes
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

-- ============================================================
-- 5. residual-files storage bucket + policies
-- ============================================================
-- Retains the ORIGINAL uploaded file (xlsx fee report / pdf volume
-- statement) behind every residual_imports row.
--
-- PATH SCHEME (to be enforced by the upload helper, mirroring
-- lib/marketing/lead-list-files-client.ts):
--     ${residual_import_id}/${random_uuid}.${ext}
-- The first '/'-segment of storage.objects.name is the residual_imports
-- UUID, and residual_imports.storage_path must be written with that same
-- computed path — one source of truth for the path, so the ingest step
-- can find the object it is meant to parse.
--
-- ORDERING CONSTRAINT: the residual_imports row MUST be INSERTed before
-- the browser uploads the file. This mirrors the lead-list flow. Here the
-- dependency is weaker than lead-list's (these policies do not read the
-- row), but the ordering still matters operationally: an object whose
-- path prefix has no owning row is unreachable orphaned bytes, since the
-- row is the only thing that records where the file lives.
--
-- ACCESS MODEL — deliberate deviation from lead-list-files:
-- lead-list-files calls public.user_can_access_lead_list(uuid) because
-- lead lists have genuine per-row access differences (creator, campaign
-- team members). Residuals have none: every write is admin/super_admin,
-- and any admin may read any import. A per-row SECURITY DEFINER helper
-- would therefore be pure ceremony — it would compile to "is this a real
-- import id", which is not a security boundary. Gating on auth_role()
-- directly is the simpler correct option and is STRICTER than the
-- lead-list bucket (which admits any authenticated user who passes the
-- row check), which is appropriate for financial documents.
-- If a later slice introduces non-admin residual access (e.g. an agent
-- who may see only their own merchants), replace the auth_role() clause
-- with a public.user_can_access_residual_import(uuid) helper using the
-- same (string_to_array(name, '/'))[1]::uuid path extraction.
--
-- No UPDATE policy: storage paths in this bucket are immutable, matching
-- lead-list-files. Replacing a file means a new import row and a new
-- object.
insert into storage.buckets (id, name, public)
values ('residual-files', 'residual-files', false)
on conflict (id) do nothing;

drop policy if exists "residual_files_select_admin" on storage.objects;
create policy "residual_files_select_admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'residual-files'
    and public.auth_is_admin()
  );

drop policy if exists "residual_files_insert_admin" on storage.objects;
create policy "residual_files_insert_admin"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'residual-files'
    and public.auth_is_admin()
  );

drop policy if exists "residual_files_delete_admin" on storage.objects;
create policy "residual_files_delete_admin"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'residual-files'
    and public.auth_is_admin()
  );

commit;
