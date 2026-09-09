-- =============================================================================
-- Module 2 — Part 52: three rules from the client's own documents that the
-- handover document did not carry, and which therefore were never built.
--
--   1. Restore must refuse a Deal Name collision with a message that can name
--      and link the blocking record.        (Overview §3.5, Admin Plan §6)
--   2. That message must be VISIBILITY-AWARE — it may only identify the
--      blocking record to someone allowed to see it.   (Modules Amendment 2)
--   3. Deleting a record requires Edit on Deal Name.       (Admin Plan §2.2)
--
-- ── 1 AND 2: THE COLLISION, AND WHO MAY BE TOLD ABOUT IT ─────────────────
-- `records_deal_name_unique` is `unique (lower(btrim(deal_name))) where
-- deleted_at is null`, so a soft-deleted record's name is released for reuse —
-- correct, and exactly what §5.3 asks for. The consequence nobody handled: if
-- somebody takes that name while the record sits in the bin, restoring it
-- violates the index. Verified against the live database: the restore fails
-- with a bare
--
--     23505 duplicate key value violates unique constraint
--            "records_deal_name_unique"
--
-- The database refusing is right. The bare error is not: the client asked for
-- "a clear, linked error message". So `deal_name_conflict()` below finds the
-- blocker BEFORE the write, and `restore_record` raises a message the app can
-- turn into that link.
--
-- The visibility gate is Amendment 2, and it is a real disclosure rule, not
-- decoration: the duplicate CHECK always runs against every non-deleted record
-- in the system regardless of who is asking, but the MESSAGE may only identify
-- the blocker to someone who can already see it. Otherwise the error becomes an
-- oracle: type a name, learn whether a record you have no access to exists, and
-- what it is called. So the function returns the id, and `record_visible()`
-- decides in the data layer whether the caller may be told which record it is.
--
-- ── 3: DELETE REQUIRES EDIT ON DEAL NAME ─────────────────────────────────
-- Admin Plan §2.2: "deleting a record requires that the user can see the record
-- and holds Edit access on the primary field (Deal Name)." Only the first half
-- was enforced. `delete_record` checked `record_visible` and the
-- archive-before-delete rule and nothing else, so any team member of an
-- archived record could soft-delete it.
--
-- Checked in SQL rather than in the action, because `effective_grant()` is
-- already a SQL function and CLAUDE.md rule 2 puts the gate below the app
-- layer. The floors from `grantRules.ts` do not need repeating here: Deal Name
-- is never read-only and its floor only RAISES a grant to View, which is still
-- short of the Edit this requires.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Who, if anyone, already holds this Deal Name.
--
-- Normalisation is `lower(btrim(...))`, character-for-character the expression
-- behind `records_deal_name_unique`. If these two ever disagree the check would
-- pass and the write would still fail, which is the failure this exists to
-- prevent — so they are written the same way on purpose.
--
-- `security definer`: it must see EVERY non-deleted record, including ones the
-- caller cannot, because the block itself is system-wide. Disclosure is decided
-- by the caller afterwards, never here.
-- -----------------------------------------------------------------------------
create or replace function deal_name_conflict(
  p_name    text,
  p_exclude uuid default null
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id
    from records r
   where r.deleted_at is null
     and lower(btrim(r.deal_name)) = lower(btrim(p_name))
     and (p_exclude is null or r.id <> p_exclude)
   limit 1;
$$;

revoke execute on function deal_name_conflict(text, uuid) from public;
grant execute on function deal_name_conflict(text, uuid) to authenticated;

comment on function deal_name_conflict(text, uuid) is
  'The id of the non-deleted record already holding this Deal Name, or null. '
  'Sees every record by design — the duplicate block is system-wide. Whether '
  'the caller may be TOLD which record it is depends on record_visible(), and '
  'is decided by the data layer (Modules Amendment 2).';

-- -----------------------------------------------------------------------------
-- restore_record — now refuses a collision before it can become a 23505.
-- Body otherwise carried over from migration 20.
-- -----------------------------------------------------------------------------
create or replace function restore_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name     text;
  v_conflict uuid;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  select deal_name into v_name from records where id = rec and deleted_at is not null;
  if v_name is null then
    raise exception 'not found';
  end if;

  -- Checked here rather than left to the unique index, so the caller gets the
  -- blocking record's id and can build the message the client asked for.
  -- `errcode 23505` is kept deliberately: any caller that already treats a
  -- duplicate as a duplicate keeps working, and the id rides in the hint.
  v_conflict := deal_name_conflict(v_name, rec);
  if v_conflict is not null then
    raise exception 'A record named % already exists.', v_name
      using errcode = '23505', hint = v_conflict::text;
  end if;

  update records set deleted_at = null where id = rec;

  -- The archive-before-delete rule (Modules Amendment 1) means a record always
  -- holds zero display memberships by the time it can be deleted, so "the exact
  -- set of memberships it held at the moment of deletion" (Overview §3.5) is
  -- always the empty set. Admin Plan §6 names that case explicitly as valid.
  insert into record_activity (record_id, actor_id, kind, summary)
  values (rec, auth.uid(), 'record', 'Restored from the Recycle Bin — archived (no display memberships)');
end;
$$;

revoke execute on function restore_record(uuid) from public;
grant execute on function restore_record(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- delete_record — now also requires Edit on Deal Name.
-- Body otherwise carried over from migration 20.
-- -----------------------------------------------------------------------------
create or replace function delete_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deal_name_field uuid;
begin
  if not record_visible(rec) then
    raise exception 'not found';
  end if;

  if exists (select 1 from record_modules where record_id = rec) then
    raise exception 'Archive this record before deleting it — it is still displayed in a module'
      using errcode = '23514';
  end if;

  -- Admin Plan §2.2. Admins short-circuit exactly as they do everywhere else in
  -- the grant model; for everyone else the primary field's own grant decides.
  if not auth_is_admin() then
    select id into v_deal_name_field from fields where key = 'deal_name';
    if v_deal_name_field is null
       or effective_grant(auth.uid(), 'field', v_deal_name_field) <> 'edit' then
      raise exception 'Deleting a record needs Edit access on Deal Name'
        using errcode = '42501';
    end if;
  end if;

  update records set deleted_at = now() where id = rec;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (rec, auth.uid(), 'record', 'Deleted — moved to the Recycle Bin');
end;
$$;

revoke execute on function delete_record(uuid) from public;
grant execute on function delete_record(uuid) to authenticated;
