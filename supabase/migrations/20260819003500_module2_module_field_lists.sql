-- =============================================================================
-- Module 2 — Part 35: atomic full-replace for the two per-module field lists,
-- plus the database half of "Deal Name is never a configurable column".
--
-- Presets sub-step 3 (Admin → Columns & header strip) sets a module's WHOLE
-- ordered list at once rather than diffing row by row. Done from the app that
-- is a DELETE and an INSERT in two separate round trips: if the second half
-- fails, the module is left with ZERO columns and its dashboard renders
-- nothing but the frozen Deal Name — a config screen that can empty a
-- dashboard by failing halfway. One function body is one transaction, so it
-- either all lands or none of it does.
--
-- ── WHY DEAL NAME MUST NEVER BE IN EITHER TABLE ──────────────────────────
-- CLIENT-SPEC-BY-MODULE §1: "Deal Name is always column 1, in every module,
-- frozen, cannot be de-selected." This build satisfies that by NOT making it
-- a configurable column at all — `DataTable` draws it as a hardcoded <th>
-- before the configured ones (`proto/ui/DataTable.tsx:639`, from
-- `records.deal_name`, not from `records.values`), and the drawer prints it
-- as the title above the header strip (`proto/ui/Drawer.tsx:123`). The
-- prototype states the consequence outright (`proto/store.tsx:323`): "Deal
-- Name is not in `columnIn` … so it never enters this list and can never be
-- dragged — the amendment's 'not draggable, nothing can land before it' is
-- true by construction here."
--
-- So a `module_columns` row for Deal Name does not pin it to position 1 — it
-- renders it a SECOND time, after every other column, reading its value out
-- of a JSONB key that nothing writes. Same in the drawer: a header-strip
-- entry repeats the title immediately under itself. Neither errors; both just
-- look wrong, which is exactly the class of failure CLAUDE.md asks to be
-- pushed into the database. `remaining-plan.md` § Phase 2 says to force
-- `deal_name` to index 0 in the writer; that instruction was written against
-- the spec rather than against this renderer, and following it would produce
-- the duplicate. The rule is enforced here as its inverse, and in
-- `adminColumns.ts` (which never offers or accepts it) as the code half.
--
-- Naming the FIELD key `deal_name` in SQL is fine — CLAUDE.md §1 forbids code
-- naming a MODULE. `permissions.ts` already names this same field key, for
-- the two rules that already depend on it.
-- =============================================================================

create or replace function module_field_list_reject_frozen()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from fields f where f.id = new.field_id and f.key = 'deal_name') then
    raise exception 'Deal Name is drawn as the frozen first column and the drawer title — it cannot also be a configured column or header field'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger module_columns_reject_frozen
  before insert or update of field_id on module_columns
  for each row execute function module_field_list_reject_frozen();

create trigger module_header_fields_reject_frozen
  before insert or update of field_id on module_header_fields
  for each row execute function module_field_list_reject_frozen();

-- -----------------------------------------------------------------------------
-- The two full-replace writers.
--
-- ── WHY ARCHIVED FIELDS' ROWS SURVIVE THE REPLACE ────────────────────────
-- Phase 1 made archiving a field deliberately LEAVE its `module_columns` /
-- `module_header_fields` rows in place — that is what makes restoring the
-- field put it back exactly where it was, and they leak nothing meanwhile
-- because `columnsForModule`/`headerFieldsForModule` resolve id → field
-- against the archived-filtered set and drop the misses (`config.ts:232-246`).
-- An archived field is therefore absent from the admin picker, so a naive
-- full replace would delete those rows as "not selected" and quietly break
-- restore. The DELETE below is scoped to live fields only.
--
-- ── WHY POSITIONS STEP BY 10 ─────────────────────────────────────────────
-- Only relative order matters (both readers sort by `position`), and the
-- seed already uses a sparse scale. Keeping gaps means a preserved archived
-- row — still holding its original position — restores back into roughly the
-- slot it had, instead of always landing last behind a contiguous 0..n-1 run.
--
-- Both are `security definer` with a pinned `search_path` per CLAUDE.md §8,
-- and reachable only through the service role: the admin check is
-- `assertAdmin(ctx)` in `adminColumns.ts`, and no browser-side role has any
-- reason to call these directly (migration 19's convention — revoke PUBLIC's
-- automatic grant, and do not restate one for `authenticated`).
-- -----------------------------------------------------------------------------

create or replace function set_module_columns(p_module_id uuid, p_field_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from module_columns mc
    using fields f
   where mc.module_id = p_module_id
     and f.id = mc.field_id
     and f.archived_at is null;

  -- The join is the validation: an id that is not a live field is dropped
  -- rather than raising, so a stale form (submitted after someone else
  -- archived a field) saves the rest of the admin's ordering instead of
  -- failing the whole write.
  insert into module_columns (module_id, field_id, position)
  select p_module_id, v.field_id, (v.ord - 1) * 10
    from unnest(p_field_ids) with ordinality as v(field_id, ord)
    join fields f on f.id = v.field_id
   where f.archived_at is null;
end;
$$;

create or replace function set_module_header_fields(p_module_id uuid, p_field_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from module_header_fields mh
    using fields f
   where mh.module_id = p_module_id
     and f.id = mh.field_id
     and f.archived_at is null;

  insert into module_header_fields (module_id, field_id, position)
  select p_module_id, v.field_id, (v.ord - 1) * 10
    from unnest(p_field_ids) with ordinality as v(field_id, ord)
    join fields f on f.id = v.field_id
   where f.archived_at is null;
end;
$$;

revoke execute on function set_module_columns(uuid, uuid[])       from public, anon, authenticated;
revoke execute on function set_module_header_fields(uuid, uuid[]) from public, anon, authenticated;
