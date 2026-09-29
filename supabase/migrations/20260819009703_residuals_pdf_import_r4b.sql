-- Ported from Daniel Weissman's residuals branch, file
-- `20260824120000_residuals_pdf_import_r4b.sql`.
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
-- Residuals R4b — PDF merchant-statement import
-- ============================================================
--
-- Three things:
--   1. find_live_records_by_mid_suffix — resolve a statement's masked
--      Merchant Number to merchant record(s), returning ALL matches.
--   2. commit_residual_pdf_import — the atomic volumes commit, structurally
--      identical to R4a's commit_residual_excel_import.
--   3. commit_residual_excel_import DROPPED and recreated returning jsonb
--      {"inserted":N,"swept":M} instead of a bare integer, so both importers
--      report replacement counts identically.
--
-- Extraction itself lives in the app (lib/residuals/pdf-parser.ts). The
-- database receives already-rolled-up bucket totals that have passed the
-- statement's own '**' reconciliation; it does not re-derive them.
--
-- residual_merchant_volumes keeps R1b's original four buckets (amex/vmd/
-- debit/ebt). A fifth, paypal_volume, was built during R4b development
-- against the statement legend's PP - PAYPAL code, but no sampled statement
-- ever carried a PP row, so it was removed before ship rather than committed
-- unverified. PP now fails loud like the cash-advance codes: see ROLLUP's
-- comment in lib/residuals/pdf-layout.ts.

begin;

-- ============================================================
-- 1. find_live_records_by_mid_suffix
-- ============================================================
-- A merchant statement masks its Merchant Number with a FIXED four-character
-- prefix: "xxxx201100269662" is 4 x's followed by the COMPLETE 12-digit MID,
-- and "xxxx30119808296" is 4 x's followed by the complete 11-digit MID. The
-- visible portion is therefore the whole thing today, not a truncation.
-- Suffix matching is used anyway so the resolver degrades correctly if a
-- longer MID is ever genuinely truncated by the mask.
--
-- PARITY PIN. The normalization expression below is character-for-character
-- the same one used by records_mid_unique (migration
-- 20260822120000_residuals_mid_unique_r3.sql) and by find_live_thread_by_mid:
--
--     regexp_replace(coalesce(column_data->>'mid',''),'[^0-9]','','g')
--
-- Its TypeScript twin is normalizeMidForStorage() in
-- lib/lead-gen/field-format.ts. All four must change together or the
-- resolver starts disagreeing with the index about what "the same MID" is.
--
-- RETURNS ALL MATCHES — deliberately NO LIMIT. The count IS the signal:
--   0 matches  -> volumes import unlinked (the common case today)
--   1 match    -> attach
--   2+ matches -> ambiguous; flag for manual resolution, never guess
-- A LIMIT 1 here would silently turn ambiguity into a wrong attachment.
--
-- This cannot use the R3 b-tree index: a leading-wildcard LIKE is not
-- sargable. Irrelevant at current scale (a handful of MIDs); if it ever
-- matters the fix is an index on reverse(normalized_mid) with a prefix match.
--
-- SECURITY INVOKER: lead_gen_threads' SELECT policy is open to authenticated
-- for live rows, so this returns exactly what the caller could already read.

create or replace function public.find_live_records_by_mid_suffix(p_suffix text)
returns table (record_id uuid, mid text, deal_name text)
language sql
stable
security invoker
set search_path = public
as $$
  select
    r.id,
    regexp_replace(coalesce(r.values->>'mid',''),'[^0-9]','','g'),
    nullif(btrim(coalesce(r.deal_name, '')), '')
  from public.records r
  where r.deleted_at is null
    and regexp_replace(coalesce(p_suffix,''),'[^0-9]','','g') <> ''
    and regexp_replace(coalesce(r.values->>'mid',''),'[^0-9]','','g') <> ''
    and regexp_replace(coalesce(r.values->>'mid',''),'[^0-9]','','g')
        like '%' || regexp_replace(coalesce(p_suffix,''),'[^0-9]','','g');
$$;

comment on function public.find_live_records_by_mid_suffix(text) is
  'Resolve a masked statement Merchant Number to live records by digits-only suffix match. Returns ALL matches with no LIMIT: 0 = import unlinked, 1 = attach, 2+ = ambiguous, resolve manually. Normalization is pinned identical to records_mid_unique.';

revoke all on function public.find_live_records_by_mid_suffix(text) from public;
grant execute on function public.find_live_records_by_mid_suffix(text) to authenticated;

-- ============================================================
-- 2. commit_residual_pdf_import
-- ============================================================
-- Structurally identical to commit_residual_excel_import: same admin gate,
-- same FOR UPDATE lock, same status/source/processor/period guards, same
-- period pin, same supersede sweep rule, same close. Only the target table,
-- the source_type it accepts, and the recordset column list differ. Keeping
-- the two in lockstep is deliberate — a divergence between them is far more
-- likely to be a bug than an intention.
--
-- SUPERSEDE SCOPE — identical rule to R4a, and it is NOT keyed on status.
-- residual_imports carries a partial unique on
-- (processor, period_id, source_type) WHERE status='completed' AND
-- deleted_at IS NULL, so a second completed import for the same triple can
-- never exist; a status-keyed sweep would be dead code. The real re-import
-- path is: soft-delete the old import row (dropping it out of that index),
-- then upload again. Soft-deleting the import does NOT cascade to its
-- volume rows, which stay live and would double-count. Hence "different
-- import, same triple". Verified empirically on the Excel side in R4a.
-- Manual rows (import_id IS NULL, guaranteed by
-- residual_merchant_volumes_provenance_consistent) are never swept.
--
-- SWEEP-THEN-INSERT, NOT UPSERT. residual_merchant_volumes carries
-- residual_merchant_volumes_period_mid_unique on (period_id, mid) WHERE
-- deleted_at IS NULL — a PARTIAL unique, which ON CONFLICT cannot use as a
-- conflict target. Sweeping first clears the way for a plain INSERT, which
-- is both correct and structurally the same as the Excel path.

create or replace function public.commit_residual_pdf_import(
  p_import_id uuid,
  p_period_id uuid,
  p_rows      jsonb
) returns jsonb
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
  v_swept       integer;
begin
  -- Auth gate FIRST. Definer bypasses RLS, so this is the only guard.
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to commit a residual import.'
      using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array.'
      using errcode = '22023';
  end if;

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

  if v_status <> 'processing' then
    raise exception 'Residual import % is in status %, expected processing.',
      p_import_id, v_status
      using errcode = '22023';
  end if;

  if v_source_type <> 'pdf' then
    raise exception 'Residual import % has source_type %, expected pdf.',
      p_import_id, v_source_type
      using errcode = '22023';
  end if;

  if v_processor is null or p_period_id is null then
    raise exception 'Residual import % needs both a processor and a period.',
      p_import_id
      using errcode = '22023';
  end if;

  update public.residual_imports
     set period_id = p_period_id
   where id = p_import_id;

  -- ---------- supersede sweep ----------
  update public.residual_merchant_volumes rv
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where rv.import_id = ri.id
     and rv.deleted_at is null
     and rv.import_id <> p_import_id
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  get diagnostics v_swept = row_count;

  -- ---------- insert ----------
  insert into public.residual_merchant_volumes (
    period_id,
    import_id,
    mid,
    merchant_name,
    amex_volume,
    vmd_volume,
    debit_volume,
    ebt_volume,
    source,
    created_by_id,
    updated_by_id
  )
  select
    p_period_id,
    p_import_id,
    r.mid,
    r.merchant_name,
    r.amex_volume,
    r.vmd_volume,
    r.debit_volume,
    r.ebt_volume,
    'pdf',
    v_actor,
    v_actor
  from jsonb_to_recordset(p_rows) as r(
    mid            text,
    merchant_name  text,
    amex_volume    numeric(14,2),
    vmd_volume     numeric(14,2),
    debit_volume   numeric(14,2),
    ebt_volume     numeric(14,2)
  )
  where r.mid is not null
    and btrim(r.mid) <> '';

  get diagnostics v_inserted = row_count;

  -- ---------- close the import ----------
  -- Arms residual_imports' unique-on-completed index. A live completed
  -- import already holding this triple makes THIS statement raise 23505 and
  -- rolls the whole function back — no rows inserted, no sweep applied.
  update public.residual_imports
     set status        = 'completed',
         row_count     = v_inserted,
         processed_at  = now(),
         error_message = null,
         updated_by_id = v_actor
   where id = p_import_id;

  return jsonb_build_object('inserted', v_inserted, 'swept', v_swept);
end;
$$;

comment on function public.commit_residual_pdf_import(uuid, uuid, jsonb) is
  'Atomic commit for a PDF statement import: supersede-sweeps prior volume rows for the same (processor, period, source_type), inserts residual_merchant_volumes with all numeric casting done in SQL, and flips the import to completed. Returns {"inserted":N,"swept":M}. SECURITY DEFINER with an explicit admin gate.';

revoke all on function public.commit_residual_pdf_import(uuid, uuid, jsonb) from public;
grant execute on function public.commit_residual_pdf_import(uuid, uuid, jsonb) to authenticated;

-- ============================================================
-- 3. commit_residual_excel_import — integer -> jsonb
-- ============================================================
-- R4a's version returned a bare inserted-count, so a re-import reported
-- "Imported 197 rows" with no sign that 197 prior rows were retired in the
-- same transaction. Both importers now return
-- {"inserted":N,"swept":M} so the two toasts read identically.
--
-- DROP THEN CREATE, not CREATE OR REPLACE: PostgreSQL refuses to replace a
-- function whose return type changes (42P13). The signature is otherwise
-- unchanged, so the drop targets the exact argument list.
--
-- The body is R4a's verbatim apart from capturing the sweep's row count and
-- returning the object. The supersede scope, the guards, and the ordering
-- are all unchanged — this is a return-shape change, not a behaviour change.
--
-- NOTE: the caller (ingestResidualRowsAction in
-- app/(app)/admin/residuals/actions.ts) is updated in the same commit.

drop function if exists public.commit_residual_excel_import(uuid, uuid, jsonb);

create function public.commit_residual_excel_import(
  p_import_id uuid,
  p_period_id uuid,
  p_rows      jsonb
) returns jsonb
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
  v_swept       integer;
begin
  if public.auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to commit a residual import.'
      using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array.'
      using errcode = '22023';
  end if;

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

  update public.residual_imports
     set period_id = p_period_id
   where id = p_import_id;

  -- ---------- supersede sweep ----------
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

  get diagnostics v_swept = row_count;

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

  update public.residual_imports
     set status        = 'completed',
         row_count     = v_inserted,
         processed_at  = now(),
         error_message = null,
         updated_by_id = v_actor
   where id = p_import_id;

  return jsonb_build_object('inserted', v_inserted, 'swept', v_swept);
end;
$$;

comment on function public.commit_residual_excel_import(uuid, uuid, jsonb) is
  'Atomic commit for an Excel residual import: supersede-sweeps prior lines for the same (processor, period, source_type), bulk-inserts residual_lines with all numeric casting done in SQL, and flips the import to completed. Returns {"inserted":N,"swept":M}. SECURITY DEFINER with an explicit admin gate.';

revoke all on function public.commit_residual_excel_import(uuid, uuid, jsonb) from public;
grant execute on function public.commit_residual_excel_import(uuid, uuid, jsonb) to authenticated;

commit;
