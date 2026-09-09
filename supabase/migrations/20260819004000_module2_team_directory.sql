-- =============================================================================
-- Module 2 — Part 40: the team-member directory, and a trigger that says what
-- is wrong instead of dying obscurely.
--
-- FOUND WHILE BUILDING: the `team_member` field type — the ONLY field that
-- grants record visibility (migration 6) — had no picker anywhere in the app,
-- and could not have one. `FieldRenderer` fell through to a plain text input,
-- and `record_visibility_grants` had no screen at all. Both halves of "who can
-- see this record" were mechanism with no UI.
--
-- Two things were missing in the database for that UI to exist:
--
-- ── 1. team_directory() ──────────────────────────────────────────────────
-- `profiles`' own RLS (auth foundation) lets a user read their OWN row, or
-- every row if admin. So a regular user cannot list their colleagues — which
-- is exactly what a "choose from team members" picker has to do.
-- `profile_names()` (migration 28) solves the neighbouring problem (resolve
-- ids I already hold to display names) and cannot solve this one: it takes an
-- id list, and the picker's whole job is to produce that list.
--
-- ⚠️ THIS RETURNS MORE THAN profile_names() DOES, DELIBERATELY.
-- Migration 28 is explicit that it returns "ONLY {id, full_name} — never
-- email, role, status". That was the right call for resolving an author's
-- name on a note. It is the wrong call here, and the reason is a security
-- one, not a convenience one:
--
--   * `full_name` is NULLABLE (`complete_signup` takes it as optional) and is
--     not unique. A picker offering two blank rows, or two people called
--     "J. Chen", is a picker where choosing wrong silently grants the wrong
--     person sight of a record. That is precisely the class of failure
--     CLAUDE.md is written against — no error, nothing visible in testing.
--     `email` is the only guaranteed-present, guaranteed-unique, human-
--     readable identity a profile has, so it is what makes the choice
--     unambiguous.
--   * `status` is here so the picker can refuse to offer a paused account
--     (and so an already-assigned paused member still RESOLVES to a name
--     rather than vanishing from the record silently).
--
-- What is still withheld: role, last_login_at, sessions_valid_from,
-- deleted_at — everything that says something about the account rather than
-- about who the person is. Soft-deleted profiles are excluded outright.
--
-- ── 2. sync_record_team_members(), hardened ──────────────────────────────
-- The trigger reads `values->'team_members_assigned'` and calls
-- `jsonb_array_elements_text` on it. If that value is a JSON *scalar* rather
-- than an array — which is exactly what a plain text input, or a Server
-- Action that forgot to `JSON.parse`, would store — the call fails with
-- "cannot extract elements from a scalar". Correct, but it names neither the
-- field nor the shape it wanted, on a trigger three layers below whatever
-- wrote the row. This raises the real sentence instead. Same body otherwise.
-- =============================================================================

create or replace function team_directory()
returns table (id uuid, full_name text, email text, status user_status)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.full_name, p.email, p.status
    from profiles p
   where p.deleted_at is null
   order by coalesce(p.full_name, p.email);
$$;

revoke all on function team_directory() from public, anon, authenticated;
grant execute on function team_directory() to authenticated;

create or replace function sync_record_team_members()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_raw jsonb := coalesce(new.values -> 'team_members_assigned', '[]'::jsonb);
  v_ids uuid[];
begin
  if jsonb_typeof(v_raw) <> 'array' then
    raise exception
      using errcode = '22023',
            message = format(
              'team_members_assigned must be a JSON array of user ids, got %s',
              jsonb_typeof(v_raw)
            ),
            hint = 'A value written as a JSON-encoded string instead of an array does this.';
  end if;

  select coalesce(array_agg((x)::uuid), '{}')
    into v_ids
    from jsonb_array_elements_text(v_raw) as x;

  delete from record_team_members
   where record_id = new.id and user_id <> all (v_ids);

  insert into record_team_members (record_id, user_id)
  select new.id, u from unnest(v_ids) as u
  on conflict (user_id, record_id) do nothing;

  return new;
end;
$$;
