-- =============================================================================
-- "This page didn't load" for every member, from about thirteen records on.
--
-- Reported 15 Oct 2026 by a member (Maylyn) doing ordinary data entry: the
-- Contacts table and every record drawer failed with
--
--   57014  canceling statement due to statement timeout
--
-- The `authenticated` role runs with statement_timeout = 8s, and
-- `record_values_for` took 8.2s for her thirteen visible records. It grew
-- linearly — roughly 0.6s a record — so it crossed the limit at about the
-- thirteenth record she created, and every one after made it worse. Admins
-- never saw it: `auth_is_admin()` short-circuits the whole computation, and
-- every check this project runs signs in as an admin.
--
-- Because the table renders behind the drawer, opening ANY record ran the same
-- query, so the whole module became unusable at once — and anything typed but
-- not yet saved was lost when the error page replaced the screen.
--
-- ── WHERE THE TIME WENT ──────────────────────────────────────────────────
--   1. `record_values_for` called `hidden_field_keys_for_record(r.id)` THREE
--      times per record (for `values`, for `deal_name`, for `record_creator`).
--   2. Each call walked all 134 fields through `record_scope_grant`, which for
--      every field re-resolved the MODULE grant too — the same answer 134
--      times over.
--
-- ── THE OBSERVATION THAT FIXES IT ────────────────────────────────────────
-- `record_scope_grant(rec, 'field', f)` depends on the record ONLY through the
-- set of non-admin-only modules it belongs to. Two records in the same modules
-- have identical hidden-field lists for a given user. So the list is computed
-- once per DISTINCT MODULE SET in the batch — for a member working in one
-- module, once per page instead of three times per row.
--
-- ── WHAT DOES NOT CHANGE ─────────────────────────────────────────────────
-- The permission rules. `hidden_field_keys_for_modules` is
-- `record_scope_grant` with its module set handed in rather than looked up:
-- the same `effective_grant` calls, the same max-across-modules /
-- least-within-a-module, the same `'hidden'` when a record is in no
-- non-admin-only module, the same admin short-circuit, the same field list
-- (every row of `fields`, as before). `hidden_field_keys_for_record` keeps its
-- signature and now delegates, so the `records_filterable` view and every
-- other caller get the same answer, faster.
--
-- That equivalence was not assumed: before this migration, the hidden-field
-- list for EVERY profile × EVERY record was snapshotted from the old
-- functions, and compared against the new ones afterwards. See
-- `hiddenFieldKeys.integration.test.ts` for the version that runs on every
-- `npm test`.
-- =============================================================================

-- The non-admin-only modules a record is shown in, sorted so that equal sets
-- compare equal. Exactly the join `record_scope_grant` performs.
create or replace function record_display_module_set(rec uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select array_agg(rm.module_id order by rm.module_id)
       from record_modules rm
       join modules m on m.id = rm.module_id
      where rm.record_id = rec
        and not m.admin_only),
    '{}'::uuid[]
  );
$$;

-- `record_scope_grant(rec, 'field', f.id) = 'hidden'`, for every field at once,
-- with the record's module set supplied instead of re-derived per field — and
-- the module-level grant resolved once per module instead of once per field.
create or replace function hidden_field_keys_for_modules(p_modules uuid[])
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then '{}'::text[]
    else coalesce(
      (
        with mods as (
          select mm as module_id,
                 effective_grant(auth.uid(), 'module'::grant_scope, mm, null) as module_grant
            from unnest(p_modules) as mm
        )
        select array_agg(f.key::text)
          from fields f
         where coalesce(
                 (select max(least(m.module_grant,
                                   effective_grant(auth.uid(), 'field'::grant_scope, f.id, m.module_id)))
                    from mods m),
                 'hidden'::permission_level
               ) = 'hidden'
      ),
      '{}'::text[]
    )
  end;
$$;

-- Same signature, same answer; now a thin wrapper.
create or replace function hidden_field_keys_for_record(rec uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select hidden_field_keys_for_modules(record_display_module_set(rec));
$$;

-- The batch read: one hidden-field list per distinct module set, joined back.
create or replace function record_values_for(p_ids uuid[])
returns table(id uuid, "values" jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recs as (
    select r.id, r.values, r.deal_name, r.creator_kind, r.creator_user_id,
           record_display_module_set(r.id) as mods
      from records r
     where r.id = any(p_ids)
       and record_visible(r.id)
  ),
  hidden as (
    select s.mods, hidden_field_keys_for_modules(s.mods) as keys
      from (select distinct mods from recs) s
  )
  select r.id,
         (r.values - h.keys)
         || case
              when 'deal_name' = any(h.keys) then '{}'::jsonb
              else jsonb_build_object('deal_name', r.deal_name)
            end
         || case
              when 'record_creator' = any(h.keys)
                or r.creator_kind <> 'user'
                or r.creator_user_id is null
                then '{}'::jsonb
              else jsonb_build_object(
                     'record_creator', jsonb_build_array(r.creator_user_id::text))
            end
    from recs r
    join hidden h on h.mods = r.mods;
$$;

-- Same reach as the functions they sit beside: the two new helpers are called
-- from inside SECURITY DEFINER functions and the view, never directly by a
-- browser role. `record_values_for` and `hidden_field_keys_for_record` keep
-- whatever grants they already had — CREATE OR REPLACE does not touch them.
revoke execute on function record_display_module_set(uuid) from public, anon;
revoke execute on function hidden_field_keys_for_modules(uuid[]) from public, anon;
grant execute on function record_display_module_set(uuid) to authenticated;
grant execute on function hidden_field_keys_for_modules(uuid[]) to authenticated;
