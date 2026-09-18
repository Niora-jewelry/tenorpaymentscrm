-- =============================================================================
-- Part 78: the resolvers learn about modules.
--
-- ── THE ORDER, AND WHY IT IS THIS ONE ────────────────────────────────────
-- Admin-Module-Plan §2.4 is unambiguous about user-versus-template:
--
--   "Resolution order per grant: user override if one exists, otherwise the
--    template value."
--
-- So specificity is applied INSIDE each source, never across them. A user's
-- global grant still beats a template's module-specific one, because the rule
-- is "user wins", full stop:
--
--   1. user grant     for this module
--   2. user grant     global (module_id is null)
--   3. template grant for this module
--   4. template grant global
--   5. 'edit'         — the documented default for an unset scope
--
-- The alternative — most-specific-wins across sources — would let a template
-- silently override a decision an admin made for one person, which is exactly
-- what §2.4 says must not happen.
--
-- ── EVERY OLD SIGNATURE STILL WORKS ──────────────────────────────────────
-- `effective_grant(u, kind, scope)` is kept and delegates with no module, so
-- nothing that calls it today changes behaviour or needs editing in the same
-- breath as this migration. The four-argument form is the new one.
-- =============================================================================

create or replace function public.effective_grant(
  u uuid,
  kind grant_scope,
  scope uuid,
  p_module uuid
)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    -- 1. the user's own override, for this module
    (select ug.grant_level from user_grants ug
      where ug.user_id = u and ug.scope_kind = kind and ug.scope_id = scope
        and p_module is not null and ug.module_id = p_module),
    -- 2. the user's own override, everywhere
    (select ug.grant_level from user_grants ug
      where ug.user_id = u and ug.scope_kind = kind and ug.scope_id = scope
        and ug.module_id is null),
    -- 3. their template, for this module
    (select tg.grant_level from user_templates ut
       join template_grants tg on tg.template_id = ut.template_id
      where ut.user_id = u and tg.scope_kind = kind and tg.scope_id = scope
        and p_module is not null and tg.module_id = p_module),
    -- 4. their template, everywhere
    (select tg.grant_level from user_templates ut
       join template_grants tg on tg.template_id = ut.template_id
      where ut.user_id = u and tg.scope_kind = kind and tg.scope_id = scope
        and tg.module_id is null),
    'edit'
  );
$$;

revoke execute on function public.effective_grant(uuid, grant_scope, uuid, uuid) from public, anon;
grant execute on function public.effective_grant(uuid, grant_scope, uuid, uuid) to authenticated, service_role;

/*
 * The original three-argument form, kept and delegating.
 *
 * Every existing caller — `record_tab_grant`, `hidden_field_keys`,
 * `record_module_visible`, `effective_grants`, and the app — keeps working
 * unchanged, and means "no particular module", which resolves to the global
 * rows. Changing behaviour and changing signatures in one migration is how a
 * regression becomes impossible to attribute.
 */
create or replace function public.effective_grant(u uuid, kind grant_scope, scope uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select effective_grant(u, kind, scope, null::uuid);
$$;


-- =============================================================================
-- The best grant for a scope across a RECORD's modules.
--
-- A tab grant is now per module, but a record can sit in several — and the
-- existing module ceiling already answers that case: "a record shown in both
-- Leads and Deals is one record: holding Edit on either module is holding Edit
-- on it." Generalised here rather than invented, so there is one rule.
--
-- Returns the HIGHEST resolution across the record's non-admin-only modules,
-- each capped by that module's own grant — so a tab set to Edit inside a module
-- the viewer cannot see contributes nothing.
-- =============================================================================

-- ⚠ PARAMETERS ARE `p_`-PREFIXED, and that is not style.
-- The body joins `modules m`, which has its own `kind` column of type
-- `module_kind`. Inside a SQL function a bare `kind` resolves to the COLUMN in
-- preference to the parameter, so `effective_grant(…, kind, …)` was compiled as
-- `effective_grant(uuid, module_kind, uuid, uuid)` — a function that does not
-- exist. The error names a type nothing in this file mentions, which is what
-- makes it hard to read.
create or replace function public.record_scope_grant(
  rec uuid,
  p_kind grant_scope,
  p_scope uuid
)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then 'edit'::permission_level
    else coalesce(
      (
        select max(
          least(
            effective_grant(auth.uid(), 'module'::grant_scope, rm.module_id, null),
            effective_grant(auth.uid(), p_kind, p_scope, rm.module_id)
          )
        )
          from record_modules rm
          join modules m on m.id = rm.module_id
         where rm.record_id = rec
           and not m.admin_only
      ),
      'hidden'::permission_level
    )
  end;
$$;

revoke execute on function public.record_scope_grant(uuid, grant_scope, uuid) from public, anon;
grant execute on function public.record_scope_grant(uuid, grant_scope, uuid) to authenticated, service_role;


-- ── record_tab_grant now delegates to it ─────────────────────────────────
-- Same answer as before for global grants, and the right answer once a tab is
-- set per module.
create or replace function public.record_tab_grant(rec uuid, p_tab_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select record_scope_grant(rec, 'tab'::grant_scope, t.id) from tabs t where t.key = p_tab_key),
    'hidden'::permission_level
  );
$$;


-- =============================================================================
-- Field values: hidden keys are now per RECORD, because a field's grant can
-- differ by module and a record's modules differ by record.
--
-- `hidden_field_keys()` (no argument) is kept for anything still calling it,
-- and remains the global answer. `record_values_for` uses the per-record form.
-- =============================================================================

create or replace function public.hidden_field_keys_for_record(rec uuid)
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
        select array_agg(f.key::text)
          from fields f
         where record_scope_grant(rec, 'field'::grant_scope, f.id) = 'hidden'
      ),
      '{}'::text[]
    )
  end;
$$;

revoke execute on function public.hidden_field_keys_for_record(uuid) from public, anon;
grant execute on function public.hidden_field_keys_for_record(uuid) to authenticated, service_role;

create or replace function public.record_values_for(p_ids uuid[])
returns table (id uuid, "values" jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.values - hidden_field_keys_for_record(r.id)
    from records r
   where r.id = any(p_ids)
     and record_visible(r.id);
$$;
