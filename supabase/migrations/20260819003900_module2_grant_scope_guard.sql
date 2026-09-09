-- =============================================================================
-- Module 2 — Part 39: a grant must point at a scope that exists.
--
-- Phase 6c (Admin → Templates / Users → Permissions) is the first thing in this
-- build that can write a `template_grants` or `user_grants` row. Both tables are
-- EMPTY in the live database (checked 2026-09-05, not assumed — Phase 6b seeded
-- rows by hand to verify the read-only matrix and removed them again), which is
-- why this guard can be added with no backfill and no clean-up step.
--
-- ── WHY THERE IS NO FOREIGN KEY, AND WHY THIS EXISTS INSTEAD ─────────────
-- `scope_id` is a bare uuid pointing at one of THREE tables, chosen by
-- `scope_kind` (migration 7). A polymorphic column cannot carry a foreign key,
-- so nothing has ever checked that the row it names is real.
--
-- Phase 6b found what that costs, by looking for it: a grant whose scope no
-- longer exists still resolves inside `effective_grant()` — the coalesce reads
-- `template_grants` by (kind, id) and neither knows nor cares that no field has
-- that id — but it has no row to render, so no screen in the app can show it and
-- no screen can clear it. It is a live permission that is invisible and
-- unreachable. The matrix lists them in a banner precisely because nothing else
-- would ever reveal them; that is a report, not a fix.
--
-- CLAUDE.md: rules that must never break belong in the database as well as the
-- code. The code half is `adminGrants.ts`, which only ever writes a scope it
-- rendered from `loadConfig()`. This is the half that holds against direct SQL,
-- against a stale admin screen whose field was archived and hard-deleted
-- underneath it, and against whatever writes these tables next.
--
-- ── WHAT IS DELIBERATELY *NOT* ENFORCED HERE ─────────────────────────────
-- The two field caps — Deal Name is never Hidden, a read-only field is capped at
-- View — are NOT triggers, and adding them would be a second copy of a rule that
-- is already unbypassable. They are applied on every read by `applyFieldFloors`
-- (`grantRules.ts`), so a `hidden` grant on Deal Name inserted by direct SQL
-- still resolves to View no matter who wrote it or how. What the write path adds
-- there is a *message* instead of a silently stored no-op, which belongs in the
-- data layer, not in a constraint. See `grantWriteRefusal`.
--
-- ── ARCHIVED FIELDS STILL COUNT ──────────────────────────────────────────
-- `fields` rows are archived (`archived_at`), never deleted, and this checks
-- existence only. A grant on an archived field is legitimate: restoring the
-- field must bring its permissions back with it, exactly as `restoreField`
-- already assumes for saved column orders. Deleting a field for real is part of
-- the deletion work this plan defers — and when it lands, it has to clear these
-- rows, which this trigger now makes a visible obligation rather than a silent
-- orphan.
--
-- `security definer` with a pinned `search_path` per CLAUDE.md §8: the check
-- must see the whole of `modules`/`tabs`/`fields` regardless of the writing
-- role's own row-level view, since every one of those tables has RLS enabled AND
-- forced. A trigger that could not see a row would refuse a legitimate grant.
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
  -- `modules`. `grant_scope` has exactly three values and this covers all three;
  -- a fourth would fall through to the else and be refused, which is the right
  -- default for a scope kind nothing here understands yet.
  if new.scope_kind = 'module' then
    select exists (select 1 from modules m where m.id = new.scope_id) into v_exists;
  elsif new.scope_kind = 'tab' then
    select exists (select 1 from tabs t where t.id = new.scope_id) into v_exists;
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

create trigger template_grants_scope_exists
  before insert or update on template_grants
  for each row execute function grant_scope_must_exist();

create trigger user_grants_scope_exists
  before insert or update on user_grants
  for each row execute function grant_scope_must_exist();

comment on function grant_scope_must_exist() is
  'scope_id is polymorphic across modules/tabs/fields and so cannot carry a foreign key. A grant on a scope that does not exist still resolves in effective_grant() but can never be seen or cleared from any screen.';
