-- =============================================================================
-- Module 2 — Part 28: profile_names — minimal-exposure author display names.
--
-- FOUND WHILE BUILDING: notes/updates/case-replies/custom-entries all need
-- to show "who wrote this" to any teammate who can see the record — the same
-- baseline expectation as any team-collaboration surface. But `profiles`'
-- own RLS (auth foundation, `profiles_select_self`/`profiles_select_admin`)
-- only lets a user read their OWN row or, if admin, every row — a regular
-- user cannot read a teammate's `full_name` directly. That's the right
-- default for the profiles table itself (email, role, session fields are
-- genuinely sensitive), but a display name is not, once the two of them
-- already share visibility into the same record via `record_visible()`.
--
-- This function returns ONLY {id, full_name} for a caller-supplied id list —
-- never email, role, status, or any other column — and applies no visibility
-- check of its own (there's nothing sensitive left to gate once the return
-- shape is this narrow; the record-level check already happened before any
-- caller has a reason to know these ids exist).
-- =============================================================================

create or replace function profile_names(p_ids uuid[])
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.full_name from profiles p where p.id = any(p_ids);
$$;

revoke all on function profile_names(uuid[]) from public, anon, authenticated;
grant execute on function profile_names(uuid[]) to authenticated;
