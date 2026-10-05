-- ============================================================================
-- Attach the residuals audit trigger, which was never attached to anything.
-- ============================================================================
-- `tg_residual_audit()` has existed since migration 20260819009699, the first
-- file of the residuals port. Its own comment says where it belongs:
--
--   'Writes residual_audit_log. ATTACHED TO THE TABLES whose manual edits the
--    reconciliation grid reports, so the trail covers every writer rather than
--    the ones an RPC author remembered.'
--
-- It was attached to nothing. Confirmed against the live database:
--
--   triggers attached to tg_residual_audit: 0
--   residual_audit_log rows:                0
--
-- ── WHY THIS IS THE SILENT KIND ─────────────────────────────────────────────
-- `residual_period_history` has a fourth branch reading `residual_audit_log`
-- and emitting `kind = 'manual_edit'`, filtered to exactly two tables:
--
--   where g.table_name in ('residual_lines', 'residual_merchant_volumes')
--
-- With no trigger that branch returns nothing, for ever, and without an error.
-- The reconciliation screen's "What happened to this month" panel renders the
-- other three kinds perfectly and presents the result as the complete
-- timeline, so a hand-edited volume figure leaves no trace anywhere a reader
-- will look.
--
-- That is the failure conventions 4 and 5 are written against: "gaps in a
-- history the spec requires to be complete and unbroken. Undetectable and
-- unfixable after the fact." Any month edited before this migration has
-- already lost that trail and nothing can reconstruct it.
--
-- ── WHY THE FUNCTION NEEDED A GUARD BEFORE IT COULD BE ATTACHED ─────────────
-- Attaching it as written would have been worse than leaving it off, and this
-- is the part that took measuring rather than reading.
--
-- `residual_lines` is written in bulk by machinery on every ordinary
-- operation:
--
--   · `commit_residual_excel_import` INSERTs one row per statement line — 197
--     in the real May sample — and UPDATEs up to that many again in its
--     supersede sweep.
--   · `compute_residual_period` UPDATEs EVERY line in the period on every run,
--     setting exactly six columns:
--
--       total_income, total_buy_rate, tapdash_net_before_split,
--       tapdash_net_after_split, additional_income_direct, net_income
--
-- An unconditional trigger would therefore write several hundred rows labelled
-- `manual_edit` for each import and each recalculation. `residual_period_history`
-- defaults to `p_limit => 200`, so the first recalculation would push every
-- calc run, status change and acknowledgment out of the timeline entirely —
-- turning a trail that is merely empty into one that is actively misleading.
--
-- ── THE GUARD IS DERIVED, NOT A LIST OF CALLERS ─────────────────────────────
-- Two conditions, both read off the row rather than off who wrote it. A rule
-- naming its callers goes stale the moment someone adds a writer, which is the
-- exact failure mode Daniel's comment gives for preferring a trigger over
-- per-RPC logging.
--
--   1. An INSERT is audited only when the row says it was made by hand.
--      `residual_lines.source` is already the provenance column, constrained
--      to 'excel' | 'pdf' | 'manual' with a CHECK tying 'manual' to a NULL
--      import_id. So "was this typed in" is a fact the row states, and
--      `residual_insert_manual_line` is the only thing that produces it.
--
--   2. An UPDATE is audited only when it changed something a PERSON can edit.
--      The engine's six output columns, and the bookkeeping columns every
--      writer touches, are excluded; anything else is operator-visible state.
--      That admits `residual_update_line_stated` — a human correcting a stated
--      figure on an imported line, which is precisely what the trail is for —
--      and excludes every recalculation, because the engine writes nothing
--      else.
--
-- A soft delete still audits: `deleted_at` is not in the excluded set, because
-- retiring a line IS an operator act. The import's supersede sweep also soft-
-- deletes, in bulk, and those rows are excluded by condition 1's sibling —
-- the sweep only ever touches rows whose `source` is not 'manual'.
--
-- DELETE is not audited on either table. Nothing in this module hard-deletes;
-- every removal is a soft delete, which arrives here as an UPDATE. A DELETE
-- branch would be dead code asserting a path that does not exist.
--
-- ── VOLUMES NEED NO GUARD ───────────────────────────────────────────────────
-- `residual_merchant_volumes` has exactly one writer today —
-- `residual_update_merchant_volumes`, which is hand entry — and the engine only
-- READS it. So every write to it is already a manual edit, and a guard would be
-- a condition that is always true. When the PDF importer lands it will write
-- rows with `source = 'pdf'`, and THAT is when this table needs condition 1
-- too; the note is here so the next person adds it rather than discovering a
-- flooded trail.
--
-- ── residual_merchant_rates IS DELIBERATELY NOT AUDITED ─────────────────────
-- Its history is the dated successor chain: a rate change IS a new row with an
-- `effective_from`, which is a better record than an audit entry and is what
-- `residual_merchant_rate_versions` reads. A trigger would duplicate it and
-- invite the two to disagree.
--
-- ── AFTER, NOT BEFORE ───────────────────────────────────────────────────────
-- The function only reads and returns `coalesce(new, old)`, so either works
-- mechanically. AFTER is correct in meaning: a BEFORE trigger writes the row
-- for a statement a later constraint may still reject, and `residual_lines`
-- carries a provenance CHECK while `residual_merchant_volumes` carries a
-- reconciled-period guard — both of which can refuse a write. A trail
-- asserting an edit that never landed is worse than one missing it.

begin;

-- ============================================================
-- 1. The guard
-- ============================================================
-- Replaced rather than wrapped. A second function would mean two writers for
-- one log, which is the thing convention 4 forbids for the activity log and
-- forbids here for the same reason: the day they diverge, the gap is in a
-- record nobody can reconstruct.
--
-- Everything below the guard is migration 20260819009699's body unchanged.

create or replace function public.tg_residual_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action public.residual_audit_action;
  v_before jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_after  jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_fields text[];

  /*
   * The engine's own output, plus what every writer touches. A change confined
   * to these is machinery, not an edit — see the header.
   *
   * Kept as a local array rather than a lookup table: it is the definition of
   * "not operator-editable" for this trigger, and a table would let the two
   * drift while looking authoritative.
   */
  v_machine_only text[] := array[
    'total_income', 'total_buy_rate', 'tapdash_net_before_split',
    'tapdash_net_after_split', 'additional_income_direct', 'net_income',
    'updated_at', 'updated_by_id', 'calculation_version'
  ];
begin
  /*
   * Condition 1 — an imported row's creation is not a manual edit.
   *
   * Scoped to residual_lines because that is the only audited table with a
   * `source` column today. `to_jsonb(new) ->> 'source'` rather than
   * `new.source`, because this function is attached to more than one table and
   * a direct reference would fail to compile against the one without it.
   */
  if tg_op = 'INSERT'
     and tg_table_name = 'residual_lines'
     and coalesce(v_after ->> 'source', '') <> 'manual' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'DELETE' then
    v_action := 'delete';
  elsif old.deleted_at is null and new.deleted_at is not null then
    v_action := 'delete';
  elsif old.deleted_at is not null and new.deleted_at is null then
    v_action := 'restore';
  else
    v_action := 'update';
  end if;

  if tg_op = 'UPDATE' then
    select array_agg(key order by key)
      into v_fields
      from jsonb_each(v_after)
     where v_before -> key is distinct from v_after -> key;

    -- Nothing actually changed. A row saying so is noise in a trail that is
    -- read when something has gone wrong.
    if v_fields is null then
      return new;
    end if;

    /*
     * Condition 2 — the change touched nothing a person can edit.
     *
     * `<@` is "contained by": every changed field is in the machine-only set.
     * One operator-visible field among them and the row is audited in full,
     * because a mixed write is still an edit and truncating what it reports
     * would be the hand-maintained-list problem one level down.
     */
    if v_fields <@ v_machine_only then
      return new;
    end if;
  end if;

  insert into public.residual_audit_log
    (table_name, record_id, action, actor_id, changed_fields, before_data, after_data)
  values (
    tg_table_name,
    coalesce((v_after ->> 'id')::uuid, (v_before ->> 'id')::uuid),
    v_action,
    auth.uid(),
    v_fields,
    v_before,
    v_after
  );

  return coalesce(new, old);
end;
$$;

comment on function public.tg_residual_audit() is
  'Writes residual_audit_log. Attached to residual_lines and '
  'residual_merchant_volumes — the two tables residual_period_history reads '
  'manual edits from. Skips an imported line''s INSERT and any UPDATE confined '
  'to the engine''s six output columns, so a recalculation of a 197-line month '
  'writes nothing: without that guard the trail would bury its own calc-run '
  'and acknowledgment entries under the 200-row read limit.';

revoke all on function public.tg_residual_audit() from public, anon, authenticated;

-- ============================================================
-- 2. The triggers
-- ============================================================
-- INSERT and UPDATE only. Nothing in this module hard-deletes — every removal
-- is a soft delete, which arrives as an UPDATE — so a DELETE branch would
-- assert a path that does not exist.

drop trigger if exists residual_lines_audit on public.residual_lines;
create trigger residual_lines_audit
  after insert or update on public.residual_lines
  for each row execute function public.tg_residual_audit();

drop trigger if exists residual_merchant_volumes_audit
  on public.residual_merchant_volumes;
create trigger residual_merchant_volumes_audit
  after insert or update on public.residual_merchant_volumes
  for each row execute function public.tg_residual_audit();

commit;
