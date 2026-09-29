-- Ported from Daniel Weissman's residuals branch, file
-- `20260826120000_residuals_merchant_link_r5b.sql` (2,493 lines).
--
-- ── WHAT WAS PORTED AND WHAT WAS NOT ────────────────────────────────────────
-- This is the KERNEL: the link columns, their consistency constraints, the
-- resolver, the re-adjudicator, and the relink trigger. Measured against the
-- rest of the port, these are the only parts any later migration depends on —
-- `residual_resolve_mid` is called by R5c's coverage report, and
-- `residual_reconcile_mid_links` by two later files.
--
-- DEFERRED to the admin-surface phase, because nothing in the schema needs
-- them: residual_link_worklist, residual_preview_mid_link,
-- residual_link_mid_to_thread, residual_confirm_mid_link, residual_unlink_mid,
-- residual_sweep_mid_links. Those are six operator-facing entry points onto
-- this kernel and they belong with the screens that call them.
--
-- ── THE ONE SUBSTANTIVE CHANGE ──────────────────────────────────────────────
-- His merchant records are `lead_gen_threads` with a `column_data` JSON blob;
-- ours are `records` with a `values` JSON blob. The column is therefore
-- `record_id`, not `thread_id`, and the MID is read from `values->>'mid'`.
--
-- Everything else — the five-verdict vocabulary, the refusal to guess on
-- ambiguity, the constraint making a guess unrepresentable, and the reasons
-- for each — is his, and the comments are kept in his words. They explain
-- decisions that look arbitrary until the failure they prevent is described.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- 1. The link columns
-- ============================================================================
-- Four columns on each of three tables: the pointer, how it was decided, when,
-- and who vouched for it.
--
-- THE VERDICT VOCABULARY, from his header, unchanged:
--
--   exact      digits-only equality against a live merchant record.
--   suffix     no exact candidate; exactly one live record's MID ENDS WITH
--              this one. Lower confidence by construction.
--   manual     a human picked the record.
--   ambiguous  2+ candidates. record_id stays NULL — never guessed.
--   unmatched  no candidate.
--   NULL       never adjudicated.
--
-- And why that vocabulary is a CHECK rather than a lookup table:
--
--   "An admin adding a sixth resolution status would mean nothing: no code
--    branches on it, and the five values are determined by the ALGORITHM, not
--    by data. A vocabulary that can only change when the code changes belongs
--    where the code is."
--
-- `on delete set null` is deliberate and differs from a cascade: deleting a
-- merchant record must not delete the residual lines that were billed against
-- it. The money happened; the link is what becomes unknown.
-- ============================================================================

alter table public.residual_lines
  add column if not exists record_id              uuid references public.records(id) on delete set null,
  add column if not exists thread_match           text,
  add column if not exists thread_matched_at      timestamptz,
  add column if not exists thread_confirmed_by_id uuid references public.profiles(id) on delete set null;

alter table public.residual_merchant_volumes
  add column if not exists record_id              uuid references public.records(id) on delete set null,
  add column if not exists thread_match           text,
  add column if not exists thread_matched_at      timestamptz,
  add column if not exists thread_confirmed_by_id uuid references public.profiles(id) on delete set null;

alter table public.residual_plan_volumes
  add column if not exists record_id              uuid references public.records(id) on delete set null,
  add column if not exists thread_match           text,
  add column if not exists thread_matched_at      timestamptz,
  add column if not exists thread_confirmed_by_id uuid references public.profiles(id) on delete set null;

-- ============================================================================
-- 1b. The verdict and the pointer must agree, always
-- ============================================================================
-- Without this, 'ambiguous' with a record_id set — a guess wearing the label
-- of a refusal to guess — is representable. That single state is what this
-- whole design exists to forbid, so it is forbidden by the database and not by
-- convention.
--
-- Written out three times rather than generated in a loop: a reader grepping
-- for a table name has to find its constraint.
-- ============================================================================

alter table public.residual_lines
  drop constraint if exists residual_lines_thread_link_consistent;
alter table public.residual_lines
  add constraint residual_lines_thread_link_consistent check (
    (
      (thread_match is null and record_id is null)
      or (thread_match in ('exact','suffix','manual') and record_id is not null)
      or (thread_match in ('ambiguous','unmatched')   and record_id is null)
    )
    and (thread_confirmed_by_id is null
         or thread_match in ('exact','suffix','manual'))
    and (thread_matched_at is null) = (thread_match is null)
  );

alter table public.residual_merchant_volumes
  drop constraint if exists residual_merchant_volumes_thread_link_consistent;
alter table public.residual_merchant_volumes
  add constraint residual_merchant_volumes_thread_link_consistent check (
    (
      (thread_match is null and record_id is null)
      or (thread_match in ('exact','suffix','manual') and record_id is not null)
      or (thread_match in ('ambiguous','unmatched')   and record_id is null)
    )
    and (thread_confirmed_by_id is null
         or thread_match in ('exact','suffix','manual'))
    and (thread_matched_at is null) = (thread_match is null)
  );

alter table public.residual_plan_volumes
  drop constraint if exists residual_plan_volumes_thread_link_consistent;
alter table public.residual_plan_volumes
  add constraint residual_plan_volumes_thread_link_consistent check (
    (
      (thread_match is null and record_id is null)
      or (thread_match in ('exact','suffix','manual') and record_id is not null)
      or (thread_match in ('ambiguous','unmatched')   and record_id is null)
    )
    and (thread_confirmed_by_id is null
         or thread_match in ('exact','suffix','manual'))
    and (thread_matched_at is null) = (thread_match is null)
  );

-- ============================================================================
-- 2. Indexes
-- ============================================================================
-- The normalised-MID expression is indexed on each table because every
-- resolution pass scans on it, and it is an expression rather than a stored
-- column so a plain column index would not be used.
-- ============================================================================

create index if not exists residual_lines_norm_mid
  on public.residual_lines ((regexp_replace(coalesce(mid,''),'[^0-9]','','g')))
  where deleted_at is null;
create index if not exists residual_lines_record
  on public.residual_lines (record_id) where record_id is not null;

create index if not exists residual_merchant_volumes_norm_mid
  on public.residual_merchant_volumes ((regexp_replace(coalesce(mid,''),'[^0-9]','','g')))
  where deleted_at is null;
create index if not exists residual_merchant_volumes_record
  on public.residual_merchant_volumes (record_id) where record_id is not null;

create index if not exists residual_plan_volumes_norm_mid
  on public.residual_plan_volumes ((regexp_replace(coalesce(mid,''),'[^0-9]','','g')))
  where deleted_at is null;
create index if not exists residual_plan_volumes_record
  on public.residual_plan_volumes (record_id) where record_id is not null;

-- ============================================================================
-- 3. residual_resolve_mid — THE resolution
-- ============================================================================
-- Digits-only exact equality first; suffix match only when exact finds
-- nothing; 2+ suffix candidates return 'ambiguous' with a NULL record_id
-- rather than a guess.
--
-- Always returns exactly one row, and only ever sees LIVE merchant records. It
-- answers "what would this MID resolve to today", which is the right question
-- for an unlinked row. Whether an EXISTING link is still justified is a
-- different question, answered by residual_reconcile_mid_links.
--
-- SECURITY DEFINER so the answer cannot depend on the caller's visible rows.
-- That matters more here than it did in his CRM: our `records` RLS is
-- per-user, so an invoker-rights resolver would return 'unmatched' for a
-- merchant the caller simply cannot see — turning a permission boundary into
-- a silent data error in a money path.
-- ============================================================================
create or replace function public.residual_resolve_mid(p_mid text)
returns table (record_id uuid, match_kind text, candidate_count integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_id  uuid;
  v_ids uuid[];
  v_n   integer;
begin
  -- No digits at all: a MID field holding 'n/a' or '-'. Excluded from the R3
  -- uniqueness domain for the same reason, and not a candidate for anything.
  if v_mid = '' then
    return query select null::uuid, 'unmatched'::text, 0;
    return;
  end if;

  select r.id
    into v_id
    from public.records r
   where r.deleted_at is null
     and regexp_replace(coalesce(r.values->>'mid',''),'[^0-9]','','g') = v_mid
   limit 1;

  if v_id is not null then
    return query select v_id, 'exact'::text, 1;
    return;
  end if;

  /*
   * FALLBACK ONLY. The statement mask is a fixed four-character prefix in
   * front of the COMPLETE MID, so exact equality is expected to carry every
   * real case; this branch exists for the day a longer MID is genuinely
   * truncated by the mask.
   *
   * array_agg rather than count() + min(): there is no min() aggregate for
   * uuid to lean on.
   */
  select array_agg(r.id)
    into v_ids
    from public.records r
   where r.deleted_at is null
     and regexp_replace(coalesce(r.values->>'mid',''),'[^0-9]','','g') <> ''
     and regexp_replace(coalesce(r.values->>'mid',''),'[^0-9]','','g')
         like '%' || v_mid;

  v_n := coalesce(array_length(v_ids, 1), 0);

  if v_n = 0 then
    return query select null::uuid, 'unmatched'::text, 0;
  elsif v_n = 1 then
    return query select v_ids[1], 'suffix'::text, 1;
  else
    -- Never guessed. record_id stays NULL, and the CHECK on all three tables
    -- makes it impossible to store anything else alongside this verdict.
    return query select null::uuid, 'ambiguous'::text, v_n;
  end if;
end;
$$;

comment on function public.residual_resolve_mid(text) is
  'THE residuals MID resolution. Digits-only exact equality first; suffix match '
  'only when exact finds nothing; 2+ suffix candidates return ''ambiguous'' with '
  'a NULL record_id rather than a guess. Always returns exactly one row and only '
  'ever sees LIVE records. SECURITY DEFINER so the answer cannot depend on the '
  'caller''s visible rows, and reachable by NO client role.';

-- ============================================================================
-- 4. residual_reconcile_mid_links — re-adjudication
-- ============================================================================
-- Re-decides links for one MID, or for every MID when called with NULL.
--
-- The rule it enforces, which is the subtle part: a link SURVIVES the
-- soft-delete of the record it points at. Soft-deleting a record does not
-- falsify a decision that was correct when it was made, and a human who
-- vouched for a link is not overruled by a machine pass. A machine link is
-- re-adjudicated only when the record is HARD-deleted or its MID moves away.
--
-- NO auth gate inside, deliberately. This must run from the relink trigger
-- under a service-role connection where auth.uid() is NULL. Gating happens at
-- the operator-facing entry points, and this kernel is granted to no client
-- role at all — see the REVOKE note below, which is the part that actually
-- makes that true.
-- ============================================================================
create or replace function public.residual_reconcile_mid_links(p_mid text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_touched integer := 0;
  v_n       integer;
begin
  /*
   * One statement per table rather than a loop over MIDs: the resolver is
   * stable and the join is on an indexed expression, so the planner does this
   * far better than a cursor would.
   *
   * `manual` links are excluded from re-adjudication entirely. A person made
   * that decision and a scheduled pass does not get to reverse it.
   */
  with candidates as (
    select l.id, l.mid
      from public.residual_lines l
     where l.deleted_at is null
       and (p_mid is null
            or regexp_replace(coalesce(l.mid,''),'[^0-9]','','g')
               = regexp_replace(coalesce(p_mid,''),'[^0-9]','','g'))
       and coalesce(l.thread_match, '') <> 'manual'
  ), resolved as (
    select c.id, r.record_id, r.match_kind
      from candidates c
      cross join lateral public.residual_resolve_mid(c.mid) r
  )
  update public.residual_lines l
     set record_id         = s.record_id,
         thread_match      = s.match_kind,
         thread_matched_at = now()
    from resolved s
   where l.id = s.id
     and (l.record_id is distinct from s.record_id
          or coalesce(l.thread_match,'') is distinct from s.match_kind);
  get diagnostics v_n = row_count;
  v_touched := v_touched + v_n;

  with candidates as (
    select v.id, v.mid
      from public.residual_merchant_volumes v
     where v.deleted_at is null
       and (p_mid is null
            or regexp_replace(coalesce(v.mid,''),'[^0-9]','','g')
               = regexp_replace(coalesce(p_mid,''),'[^0-9]','','g'))
       and coalesce(v.thread_match, '') <> 'manual'
  ), resolved as (
    select c.id, r.record_id, r.match_kind
      from candidates c
      cross join lateral public.residual_resolve_mid(c.mid) r
  )
  update public.residual_merchant_volumes v
     set record_id         = s.record_id,
         thread_match      = s.match_kind,
         thread_matched_at = now()
    from resolved s
   where v.id = s.id
     and (v.record_id is distinct from s.record_id
          or coalesce(v.thread_match,'') is distinct from s.match_kind);
  get diagnostics v_n = row_count;
  v_touched := v_touched + v_n;

  with candidates as (
    select p.id, p.mid
      from public.residual_plan_volumes p
     where p.deleted_at is null
       and (p_mid is null
            or regexp_replace(coalesce(p.mid,''),'[^0-9]','','g')
               = regexp_replace(coalesce(p_mid,''),'[^0-9]','','g'))
       and coalesce(p.thread_match, '') <> 'manual'
  ), resolved as (
    select c.id, r.record_id, r.match_kind
      from candidates c
      cross join lateral public.residual_resolve_mid(c.mid) r
  )
  update public.residual_plan_volumes p
     set record_id         = s.record_id,
         thread_match      = s.match_kind,
         thread_matched_at = now()
    from resolved s
   where p.id = s.id
     and (p.record_id is distinct from s.record_id
          or coalesce(p.thread_match,'') is distinct from s.match_kind);
  get diagnostics v_n = row_count;
  v_touched := v_touched + v_n;

  return v_touched;
end;
$$;

comment on function public.residual_reconcile_mid_links(text) is
  'Re-adjudicate residual links for one MID, or all MIDs when called with NULL. '
  'Manual links are never reversed by it. No auth gate by design: it runs from '
  'the relink trigger under a service-role connection where auth.uid() is NULL, '
  'and is granted to no client role.';

-- ============================================================================
-- 5. The relink trigger — guards attach to the FACT
-- ============================================================================
-- When a record's MID changes, or a record appears or is hard-deleted, every
-- residual row keyed on that MID may now resolve differently.
--
-- Attaching this to the FACT (the MID changed) rather than to the callers that
-- change it covers the drawer edit, the importer, a manual SQL fix and every
-- future write path, and cannot be forgotten by the author of the next one.
--
-- Fires on the OLD and the NEW MID: a record moving from A to B can free A for
-- something else and claim B from something else, and both sides need
-- re-deciding.
-- ============================================================================
create or replace function public.tg_records_relink_residuals()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old text := regexp_replace(coalesce(old.values->>'mid',''),'[^0-9]','','g');
  v_new text := regexp_replace(coalesce(new.values->>'mid',''),'[^0-9]','','g');
begin
  if tg_op = 'INSERT' then
    if v_new <> '' then perform public.residual_reconcile_mid_links(v_new); end if;
    return new;
  end if;

  -- A soft delete is NOT a relink event: the link survives it deliberately.
  -- Only a MID change, or a restore, re-opens the question.
  if v_old is distinct from v_new then
    if v_old <> '' then perform public.residual_reconcile_mid_links(v_old); end if;
    if v_new <> '' then perform public.residual_reconcile_mid_links(v_new); end if;
  end if;

  return new;
end;
$$;

drop trigger if exists records_relink_residuals_ins on public.records;
create trigger records_relink_residuals_ins
  after insert on public.records
  for each row execute function public.tg_records_relink_residuals();

drop trigger if exists records_relink_residuals_upd on public.records;
create trigger records_relink_residuals_upd
  after update of values on public.records
  for each row execute function public.tg_records_relink_residuals();

-- ============================================================================
-- 6. THE REVOKE HAS TO NAME THE ROLES. "FROM PUBLIC" IS NOT ENOUGH.
-- ============================================================================
-- His note, and it is the load-bearing one in this file:
--
--   Supabase's bootstrap sets `alter default privileges in schema public grant
--   all on functions to postgres, anon, authenticated, service_role`, and
--   migrations run as postgres — so every function created here is born with
--   DIRECT grants to all three client roles. `REVOKE ... FROM PUBLIC` removes
--   only the PUBLIC pseudo-role's implicit grant and leaves those entirely in
--   place.
--
--   He measured it rather than assuming: calling a gated RPC with the ANON key,
--   behind a revoke-from-PUBLIC, ran the body and returned the function's own
--   auth message rather than 'permission denied'. It had been an
--   unauthenticated endpoint the whole time.
--
-- residual_reconcile_mid_links WRITES three tables and has no auth check, for
-- the trigger reason above. Behind a revoke-from-PUBLIC alone it would be an
-- unauthenticated write endpoint. The roles are therefore named explicitly.
-- ============================================================================
revoke all on function public.residual_resolve_mid(text)
  from public, anon, authenticated;
revoke all on function public.residual_reconcile_mid_links(text)
  from public, anon, authenticated;
revoke all on function public.tg_records_relink_residuals()
  from public, anon, authenticated;

grant execute on function public.residual_resolve_mid(text)          to service_role;
grant execute on function public.residual_reconcile_mid_links(text)  to service_role;
