-- =============================================================================
-- Module 2 — Part 51: teach the scope guard what a subtab is.
--
-- Migration 50 added `'subtab'` to `grant_scope`. Until this lands, a subtab
-- grant hits `grant_scope_must_exist()`'s `else` branch and is refused — the
-- fail-closed order these two were deliberately split into.
--
-- The guard exists because `scope_id` is a polymorphic bare uuid and cannot
-- carry a foreign key: migration 39 found that a grant on a scope that no
-- longer exists resolves forever inside `effective_grant()` while being
-- invisible to, and unclearable from, every screen. A subtab grant needs the
-- same protection as the other three, and it needs it before the matrix can
-- write one.
--
-- Body is otherwise carried over verbatim from migration 39.
-- =============================================================================

create or replace function grant_scope_must_exist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exists boolean;
begin
  -- Naming these TABLES is not `if (module === 'leads')` — CLAUDE.md §1 forbids
  -- code naming a module, not code knowing that a module scope lives in
  -- `modules`. `grant_scope` has exactly four values and this covers all four;
  -- a fifth would fall through to the else and be refused, which is the right
  -- default for a scope kind nothing here understands yet.
  if new.scope_kind = 'module' then
    select exists (select 1 from modules m where m.id = new.scope_id) into v_exists;
  elsif new.scope_kind = 'tab' then
    select exists (select 1 from tabs t where t.id = new.scope_id) into v_exists;
  elsif new.scope_kind = 'subtab' then
    select exists (select 1 from subtabs s where s.id = new.scope_id) into v_exists;
  elsif new.scope_kind = 'field' then
    select exists (select 1 from fields f where f.id = new.scope_id) into v_exists;
  else
    v_exists := false;
  end if;

  if not v_exists then
    raise exception 'No % exists with id % — a grant on it would resolve for every request and be invisible to every screen.',
      new.scope_kind, new.scope_id
      using errcode = '23503';
  end if;

  return new;
end;
$$;
