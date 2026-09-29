-- Ported from Daniel Weissman's residuals branch, file
-- `20260822120000_residuals_mid_unique_r3.sql`.
--
-- REWRITTEN rather than translated. His version indexes
-- `lead_gen_threads.column_data->>'mid'`; ours indexes
-- `records.values->>'mid'`. The reasoning below is his and is kept, because it
-- explains a choice that looks arbitrary and is not.
-- ---------------------------------------------------------------------------
--
-- ============================================================================
-- Residuals R3 — MID uniqueness
-- ============================================================================
--
-- One record per MID. The MID is the residuals domain's natural key: every
-- residual line joins back to a merchant by MID, so two live records sharing
-- one MID would silently split a merchant's residuals across two records with
-- no error anywhere.
--
-- ── THE NORMALIZATION RULE — DIGITS ONLY ────────────────────────────────────
-- MIDs never contain letters. The canonical form is the input with every
-- non-digit removed:
--
--   SQL:  regexp_replace(coalesce(values->>'mid',''),'[^0-9]','','g')
--   TS:   value.replace(/\D/g, '')
--
-- Provably identical on every input: both keep exactly ASCII 0x30-0x39 and
-- drop everything else. No locale, no case folding, no Unicode-class
-- disagreement to drift apart — which is exactly why digits-only was chosen
-- over a `lower(btrim(...))` / `.toLowerCase().trim()` pair. Those two are NOT
-- equivalent on all Unicode input, and a mismatch there would let the app
-- believe a value is canonical while the index disagrees.
--
-- If you change one side, change the other IN THE SAME COMMIT.
--
-- ── WHY AN INDEX AND NOT JUST APPLICATION CODE ──────────────────────────────
-- The app normalises MID on write, so what reaches the database is already
-- canonical. This index is not the primary mechanism; it is the
-- guarantee-of-last-resort. A write path added later that forgets to
-- normalise still cannot create a duplicate merchant.
--
-- Measured before creating it: 37 live records, 36 carrying a MID, zero
-- duplicates after normalisation and zero stored non-canonically. The index
-- builds without a backfill.
--
-- ── THE PREDICATE, CLAUSE BY CLAUSE ─────────────────────────────────────────
--   deleted_at is null
--     A soft-deleted record must not reserve a MID. Restoring one from the
--     Recycle Bin into an occupied MID will fail with 23505 — that is correct,
--     and the restore path should surface it the way the write paths do.
--
--   normalized <> ''
--     Two concerns, one clause. Rows with no 'mid' key normalise to NULL and
--     are excluded. Rows holding junk ('n/a', '-') normalise to '' and must
--     NOT collide with each other — many records may legitimately hold
--     nothing useful there. Excluding '' keeps both out of the uniqueness
--     domain entirely.
--
--   `values ? 'mid'` is deliberately NOT included, though it reads as the
--   obvious guard. It is fully subsumed by the <> '' clause, and jsonb_exists
--   is not reliably IMMUTABLE across PostgreSQL versions — a partial index
--   predicate requires immutability, so a redundant clause could make this
--   migration fail to apply. regexp_replace and ->> are both IMMUTABLE.
-- ============================================================================

create unique index if not exists records_mid_unique
  on public.records
  using btree ((regexp_replace(coalesce(values->>'mid',''),'[^0-9]','','g')))
  where deleted_at is null
    and regexp_replace(coalesce(values->>'mid',''),'[^0-9]','','g') <> '';

comment on index public.records_mid_unique is
  'One live record per normalized MID. Normalization is digits-only: '
  'regexp_replace(values->>''mid'', ''[^0-9]'', '''', ''g''). The app normalizes on '
  'every write, so writes are already canonical - this index is the backstop. '
  'Catch 23505 on this index name and render "this MID already belongs to X" '
  'with a link, never a raw database error.';

-- ============================================================================
-- find_live_record_by_mid — the block-with-link lookup
-- ============================================================================
-- After a 23505 the app has to say WHICH record already owns the MID.
--
-- It matches on the SAME normalised expression the index uses, not on the raw
-- stored string. An unwired write path — the exact scenario the index defends
-- against — could have stored '201-100-169797', which an equality filter on
-- the raw value would miss even though the index collided on it. Matching
-- normalised-to-normalised keeps the lookup and the constraint in permanent
-- agreement.
--
-- SECURITY INVOKER on purpose: this returns only what the caller could already
-- read through `records`' own RLS, so a definer would be granting something
-- nobody needs. Note that our RLS is stricter than his was — a member sees
-- only records they are on — so a MID owned by a record outside their
-- visibility returns nothing. That is correct: the answer "some record you
-- cannot see owns this" is not ours to give, and the write is refused either
-- way by the index.
--
-- Returns at most one row. The index guarantees that; LIMIT 1 makes it
-- explicit rather than assumed.
-- ============================================================================
create or replace function public.find_live_record_by_mid(p_mid text)
returns table (record_id uuid, deal_name text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    r.id,
    nullif(btrim(coalesce(r.deal_name, '')), '')
  from public.records r
  where r.deleted_at is null
    and regexp_replace(coalesce(p_mid,''),'[^0-9]','','g') <> ''
    and regexp_replace(coalesce(r.values->>'mid',''),'[^0-9]','','g')
        = regexp_replace(coalesce(p_mid,''),'[^0-9]','','g')
  limit 1;
$$;

comment on function public.find_live_record_by_mid(text) is
  'Resolve the live record that already owns a MID, matching on the same '
  'digits-only normalization as records_mid_unique. Used by the 23505 catch to '
  'render a block-with-link instead of a raw constraint error.';

revoke all on function public.find_live_record_by_mid(text) from public, anon;
grant execute on function public.find_live_record_by_mid(text) to authenticated, service_role;
