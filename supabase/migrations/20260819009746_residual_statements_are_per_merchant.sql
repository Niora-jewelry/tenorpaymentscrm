begin;

-- ════════════════════════════════════════════════════════════════════════
-- A processing statement is ONE MERCHANT'S artifact, not one month's
-- ════════════════════════════════════════════════════════════════════════
--
-- R5a built the PDF path around residual_imports_processor_period_unique,
-- which allows one completed import per (processor, period, source_type). For
-- the fee report that is exactly right: Maverick sends one workbook a month
-- covering every merchant.
--
-- A statement is not like that. Maverick sends one PDF PER MERCHANT — the
-- seven delivered for August 2026 are seven files, one MID each, and a full
-- month is forty-seven of them. So the second statement of any month could
-- never be imported: measured, it raises
--
--   23505 duplicate key value violates unique constraint
--         "residual_imports_processor_period_unique"
--
-- and the whole commit rolls back.
--
-- ── WHY THE INDEX AND THE SWEEP MOVE TOGETHER ───────────────────────────
-- The index was not the only thing assuming one statement per month. The
-- supersede sweep inside commit_residual_pdf_import soft-deletes every live
-- row from any OTHER import sharing the (processor, period, source_type)
-- triple — with no merchant predicate, because under the old cardinality
-- there was only ever one merchant's worth of rows to sweep.
--
-- Relaxing the index alone would therefore replace a loud 23505 with silent
-- cross-merchant data loss: importing merchant B's statement would quietly
-- soft-delete merchant A's volumes, the import would report success, and the
-- only symptom would be A's volume-based lines going back to `no_volumes`
-- next time the period was recomputed. That is precisely the failure class
-- this project refuses to ship, so both halves are in this one migration and
-- neither is safe without the other.
--
-- ── WHAT STAYS TRUE ─────────────────────────────────────────────────────
-- The guarantee the original index existed for is unchanged: a successful
-- second load of the same processor + month + ARTIFACT still collides. All
-- that is corrected is what identifies the artifact. For a workbook that is
-- the processor and the month; for a statement it is the processor, the month
-- and the merchant.
--
-- Re-importing one merchant still means soft-deleting that merchant's earlier
-- import first. What no longer happens is one merchant blocking the other
-- forty-six.

alter table public.residual_imports
  add column if not exists mid text;

comment on column public.residual_imports.mid is
  'The merchant this artifact belongs to, for a per-merchant source such as a '
  'PDF statement. NULL for a whole-month artifact like the fee-item workbook. '
  'Set by commit_residual_pdf_import from the MID read out of the document, '
  'never from the filename or the caller.';

-- Only a per-merchant artifact carries a MID, and it is digits — the same
-- normalisation records_mid_unique and normalizeMidForStorage() use.
alter table public.residual_imports
  drop constraint if exists residual_imports_mid_shape;
alter table public.residual_imports
  add constraint residual_imports_mid_shape
  check (mid is null or (source_type = 'pdf' and mid ~ '^[0-9]+$'));

-- A completed PDF import with no MID would fall outside BOTH unique indexes
-- below and so could be loaded twice over. The function always sets one; this
-- makes that a guarantee of the schema rather than of the caller.
alter table public.residual_imports
  drop constraint if exists residual_imports_completed_pdf_has_mid;
alter table public.residual_imports
  add constraint residual_imports_completed_pdf_has_mid
  check (not (source_type = 'pdf' and status = 'completed' and mid is null));

-- ── the two artifact identities ────────────────────────────────────────
drop index if exists residual_imports_processor_period_unique;

-- A whole-month artifact: one per processor, per month, per kind. Unchanged
-- except that PDFs are now excluded and keyed by the index below instead.
create unique index if not exists residual_imports_processor_period_unique
  on public.residual_imports (processor, period_id, source_type)
  where deleted_at is null
    and status = 'completed'
    and processor is not null
    and period_id is not null
    and source_type <> 'pdf';

-- A per-merchant artifact: one statement per processor, per month, per MID.
create unique index if not exists residual_imports_statement_unique
  on public.residual_imports (processor, period_id, mid)
  where deleted_at is null
    and status = 'completed'
    and processor is not null
    and period_id is not null
    and source_type = 'pdf'
    and mid is not null;

-- ════════════════════════════════════════════════════════════════════════
-- commit_residual_pdf_import — pins the MID, and sweeps only that merchant
-- ════════════════════════════════════════════════════════════════════════
-- Reproduced from 20260819009704 with three changes, each marked in place:
-- the MID is pinned onto the import row beside the period, and both supersede
-- sweeps gained a `mid` predicate. Everything else, including the admin gate,
-- the FOR UPDATE lock, the status and source_type guards and the unreconciled
-- landing behaviour, is character-for-character the R5a function.

create or replace function public.commit_residual_pdf_import(
  p_import_id uuid,
  p_period_id uuid,
  p_merchant  jsonb,
  p_plan_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_processor    text;
  v_source_type  text;
  v_status       text;
  v_mid          text;
  v_merchant_nm  text;
  v_stated_total numeric(14,2);
  v_stated_count integer;
  v_rollup       jsonb;
  v_reconciled   boolean;
  v_inserted     integer;
  v_swept        integer;
  v_plan_ins     integer;
  v_plan_swept   integer;
begin
  -- Auth gate FIRST. Definer bypasses RLS, so this is the only guard.
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to commit a residual import.'
      using errcode = '42501';
  end if;

  if p_plan_rows is null or jsonb_typeof(p_plan_rows) <> 'array' then
    raise exception 'p_plan_rows must be a JSON array.'
      using errcode = '22023';
  end if;

  if p_merchant is null or jsonb_typeof(p_merchant) <> 'object' then
    raise exception 'p_merchant must be a JSON object.'
      using errcode = '22023';
  end if;

  -- ---------- merchant identity ----------
  -- Re-normalized here with the R3 digits-only expression rather than trusted
  -- from the caller. Pinned character-for-character to
  -- records_mid_unique, find_live_thread_by_mid and
  -- find_live_threads_by_mid_suffix; the TypeScript twin is
  -- normalizeMidForStorage(). All five change together or not at all.
  v_mid := regexp_replace(coalesce(p_merchant->>'mid', ''), '[^0-9]', '', 'g');
  if v_mid = '' then
    raise exception 'p_merchant.mid has no digits.'
      using errcode = '22023';
  end if;

  v_merchant_nm  := nullif(btrim(coalesce(p_merchant->>'merchant_name', '')), '');
  v_stated_count := nullif(p_merchant->>'stated_item_count', '')::integer;

  -- stated_total is REQUIRED. interpretStatement already refuses a statement
  -- with no '**' totals row ("Refusing to import a statement that can't be
  -- reconciled"); enforcing it here too means that guarantee survives any
  -- caller, not just the one we ship.
  v_stated_total := nullif(p_merchant->>'stated_total', '')::numeric(14,2);
  if v_stated_total is null then
    raise exception 'p_merchant.stated_total is required (the statement''s ''**'' row).'
      using errcode = '22023';
  end if;

  -- ---------- import row: lock and guard ----------
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

  -- Pin the resolved period in the SAME transaction as the rows, so the import
  -- and its data can never disagree about which month they belong to. Also
  -- arms the idempotency index, which keys on period_id.
  -- Pins the MID too, for the same reason and in the same breath: a statement
  -- is one merchant's artifact, and residual_imports_statement_unique keys on
  -- it. Set here rather than trusted from the caller so the keyed value is the
  -- one that was actually read out of the document.
  update public.residual_imports
     set period_id = p_period_id,
         mid       = v_mid
   where id = p_import_id;

  -- ---------- derive, before writing anything ----------
  -- The identical call previewResidualPdfAction made on the identical input.
  v_rollup     := public.residual_derive_plan_rollup(p_plan_rows, v_stated_total);
  v_reconciled := (v_rollup->>'reconciled')::boolean;

  if (v_rollup->>'plan_row_count')::integer = 0 then
    raise exception 'p_plan_rows contains no usable plan rows.'
      using errcode = '22023';
  end if;

  -- VETO POINT. To restore R4b's abort-on-mismatch behaviour, uncomment:
  --
  --   if not v_reconciled then
  --     raise exception 'Statement does not reconcile: derived % vs stated %.',
  --       v_rollup->>'derived_total', v_rollup->>'stated_total'
  --       using errcode = '22023';
  --   end if;
  --
  -- Everything below already handles the unreconciled case correctly, so this
  -- is genuinely a one-block change in either direction.

  -- ---------- supersede sweep ----------
  -- Soft-delete every live row for THIS MERCHANT belonging to a DIFFERENT
  -- import that shares this import's (processor, period_id, source_type).
  --
  -- The `mid` predicate is load-bearing. Without it the sweep clears every
  -- merchant in the month, which was correct while a month could hold only one
  -- completed PDF import and is silent data loss now that it holds one per
  -- merchant. It pairs with residual_imports_statement_unique; neither is safe
  -- without the other, so they went in together.
  --
  -- Why not keyed on status: residual_imports carries a partial unique on that
  -- triple WHERE status='completed' AND deleted_at IS NULL, so a second
  -- completed import for the same triple cannot exist and a status-keyed sweep
  -- would be dead code. The real re-import path is soft-delete-the-import then
  -- re-upload, and soft-deleting an import does NOT cascade to its rows —
  -- which would double-count. Hence "different import, same triple".
  --
  -- Manual rows are never swept: the provenance CHECK on both tables
  -- guarantees source='manual' implies import_id IS NULL, so the join excludes
  -- them outright.
  --
  -- ORDER IS FREE. There is no FK between residual_plan_volumes and
  -- residual_merchant_volumes — they are siblings keyed on (period, mid), not
  -- parent and child. Plan rows are swept first only for readability.
  --
  -- Both sweeps must precede their inserts: both uniques are PARTIAL and so
  -- cannot serve as an ON CONFLICT target (the R4b reasoning).

  update public.residual_plan_volumes pv
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where pv.import_id = ri.id
     and pv.deleted_at is null
     and pv.import_id <> p_import_id
     and pv.mid = v_mid
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  get diagnostics v_plan_swept = row_count;

  update public.residual_merchant_volumes rv
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where rv.import_id = ri.id
     and rv.deleted_at is null
     and rv.import_id <> p_import_id
     and rv.mid = v_mid
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  get diagnostics v_swept = row_count;

  -- ---------- insert the plan-row detail ----------
  -- volume_bucket is resolved by the SAME left join residual_derive_plan_rollup
  -- used, against the same live map rows, inside the same transaction — so the
  -- stored bucket and the derived totals cannot disagree.
  insert into public.residual_plan_volumes (
    period_id, import_id, mid, plan_code, volume_bucket,
    amount, item_count, source, created_by_id, updated_by_id
  )
  select
    p_period_id,
    p_import_id,
    v_mid,
    upper(btrim(r.plan_code)),
    b.volume_bucket,
    r.amount,
    r.item_count,
    'pdf',
    v_actor,
    v_actor
  from jsonb_to_recordset(p_plan_rows) as r(
    plan_code   text,
    amount      numeric(14,2),
    item_count  integer
  )
  left join public.residual_plan_code_buckets b
    on b.plan_code = upper(btrim(r.plan_code))
   and b.deleted_at is null
  where btrim(coalesce(r.plan_code, '')) <> ''
    and r.amount is not null;

  get diagnostics v_plan_ins = row_count;

  -- ---------- insert the rolled-up merchant row ----------
  -- The four dollar buckets and the four counts are written ONLY when the
  -- statement reconciled. Otherwise NULL — not partial, not zero. See the
  -- BEHAVIOUR CHANGE note above.
  insert into public.residual_merchant_volumes (
    period_id, import_id, mid, merchant_name,
    amex_volume, vmd_volume, debit_volume, ebt_volume,
    amex_item_count, vmd_item_count, debit_item_count, ebt_item_count,
    stated_total, stated_item_count, reconciled, unmapped_volume,
    source, created_by_id, updated_by_id
  )
  values (
    p_period_id,
    p_import_id,
    v_mid,
    v_merchant_nm,

    case when v_reconciled then (v_rollup#>>'{buckets,amex_volume}')::numeric(14,2)  end,
    case when v_reconciled then (v_rollup#>>'{buckets,vmd_volume}')::numeric(14,2)   end,
    case when v_reconciled then (v_rollup#>>'{buckets,debit_volume}')::numeric(14,2) end,
    case when v_reconciled then (v_rollup#>>'{buckets,ebt_volume}')::numeric(14,2)   end,

    case when v_reconciled then (v_rollup#>>'{counts,amex_item_count}')::integer  end,
    case when v_reconciled then (v_rollup#>>'{counts,vmd_item_count}')::integer   end,
    case when v_reconciled then (v_rollup#>>'{counts,debit_item_count}')::integer end,
    case when v_reconciled then (v_rollup#>>'{counts,ebt_item_count}')::integer   end,

    v_stated_total,
    v_stated_count,
    v_reconciled,
    (v_rollup->>'unmapped_volume')::numeric(14,2),

    'pdf',
    v_actor,
    v_actor
  );

  get diagnostics v_inserted = row_count;

  -- ---------- close the import ----------
  -- Arms residual_imports_statement_unique. A live completed import already
  -- holding this (processor, period, mid) makes THIS statement raise 23505 and
  -- rolls the whole function back — no rows inserted, no sweep applied. Re-
  -- importing one merchant's statement therefore still has to soft-delete the
  -- earlier import first; what changed is that the OTHER merchants' imports no
  -- longer collide with it.
  update public.residual_imports
     set status        = 'completed',
         row_count     = v_inserted,
         processed_at  = now(),
         error_message = null,
         updated_by_id = v_actor
   where id = p_import_id;

  -- "inserted" and "swept" keep their R4b meanings (merchant-volume rows) so
  -- readCommitCounts in actions.ts needs no change. Everything else is added.
  return jsonb_build_object(
    'inserted',          v_inserted,
    'swept',             v_swept,
    'plan_rows_inserted', v_plan_ins,
    'plan_rows_swept',    v_plan_swept,
    'reconciled',         v_reconciled,
    'derived_total',      v_rollup->>'derived_total',
    'stated_total',       v_rollup->>'stated_total',
    'unmapped_volume',    v_rollup->>'unmapped_volume',
    'unmapped_codes',     v_rollup->'unmapped_codes_with_volume',
    'has_counts',         (v_rollup->>'has_counts')::boolean
  );
end;
$$;
comment on function public.commit_residual_pdf_import(uuid, uuid, jsonb, jsonb) is
  'Atomic commit for ONE MERCHANT''S PDF statement. Receives PLAN ROWS (not finished buckets), stores them at (period, mid, plan_code) grain, derives the four dollar buckets and four transaction counts via residual_derive_plan_rollup, and reconciles against the statement''s stated total — all in SQL. Pins the MID onto the import row and supersede-sweeps only THAT merchant''s rows for the same (processor, period, source_type). An unreconciled statement LANDS with reconciled=false and NULL buckets rather than aborting. SECURITY DEFINER with an explicit admin gate.';

revoke all on function public.commit_residual_pdf_import(uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.commit_residual_pdf_import(uuid, uuid, jsonb, jsonb) to authenticated;

commit;
