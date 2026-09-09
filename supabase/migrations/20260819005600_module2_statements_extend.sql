-- =============================================================================
-- Module 2 — Part 56: an admin can extend the Statements month grid.
--
-- ── THE REQUIREMENT ──────────────────────────────────────────────────────
-- Modules Plan, Amendment 4: "The Statements month grid ships prebuilt from
-- July 2024 through December 2032. The Admin Panel provides an **Add
-- months/years control** on the Statements system structure allowing an admin
-- to extend the grid forward by additional full years (e.g., adding 2033
-- creates its twelve month rows across every record simultaneously, since the
-- structure is global). Extension is **append-only**: months can be added,
-- never removed, and the July 2024 start point is fixed. Newly added years
-- appear immediately in the year selector in both the Records List and
-- Residuals renderings of the tab."
--
-- The grid was seeded once and there was no way to extend it. Come January
-- 2033 the tab simply stops having anywhere to put a statement.
--
-- ── WHY "ACROSS EVERY RECORD SIMULTANEOUSLY" IS FREE HERE ────────────────
-- `statement_periods` is a single global table of (year, month) — the months
-- are not per record, and `statement_files` points at a period. So adding a
-- year is twelve rows in one table, and every record's tab gains them at once
-- because every record reads the same list. That is the design the client's
-- own sentence describes, and it is already what the seed did.
--
-- ── APPEND-ONLY, ENFORCED ────────────────────────────────────────────────
-- No removal function is provided, deliberately: "months can be added, never
-- removed". The existing check constraint already pins the July 2024 floor.
-- Adding a year that exists is a no-op rather than an error, so a double click
-- cannot fail.
-- =============================================================================

create or replace function add_statement_year(p_year int)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_added int;
  v_max   int;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  -- A sane window rather than an unbounded int: a typo of 20233 would insert
  -- twelve rows nobody can reach and which cannot be removed.
  if p_year < 2024 or p_year > 2100 then
    raise exception 'Year must be between 2024 and 2100' using errcode = '23514';
  end if;

  select coalesce(max(year), 2024) into v_max from statement_periods;

  -- Append-only means forward-only: the grid must stay contiguous, because the
  -- year selector walks it and a hole would read as data loss.
  if p_year <= v_max then
    return 0;   -- already covered; a repeated click is a no-op, not an error
  end if;
  if p_year > v_max + 1 then
    raise exception 'Add % first — the month grid has to stay contiguous', v_max + 1
      using errcode = '23514';
  end if;

  insert into statement_periods (year, month)
  select p_year, m from generate_series(1, 12) m
  on conflict do nothing;

  get diagnostics v_added = row_count;
  return v_added;
end;
$$;

revoke execute on function add_statement_year(int) from public;
grant execute on function add_statement_year(int) to authenticated;

comment on function add_statement_year(int) is
  'Adds one full year of month rows to the global Statements grid '
  '(Modules Amendment 4). Append-only and contiguous: the next year only, '
  'never a removal, and re-adding an existing year is a no-op.';
