-- =============================================================================
-- Permissions spec: "The most specific setting wins. A field or sub tab
-- setting beats its tab setting." … "An override can be higher or lower than
-- the tab. For example, Pricing can be View only for Sales agents while one
-- Pricing field is Edit."
--
-- Until now a field was least(tab, sub-tab, field): it could only ever be
-- LOWER than its tab, so that example could not be built. And a sub-tab with
-- nothing set resolved to Edit on its own here (the app capped it; SQL did
-- not). Both now resolve the same way, in SQL and in `permissions.ts`:
--
--     field     = its own setting ?? its sub-tab's ?? its tab's ?? Edit
--     sub-tab   = its own setting ?? its tab's ?? Edit
--     tab       = its own setting ?? Edit                      (unchanged)
--
-- "Not set" therefore means exactly "follows the level above". Module access
-- (Hidden / Only mine / All records) stays the outer limit: nothing here can
-- show a record, or a field in a module, the person cannot open.
--
-- Lists and search follow the same rule (hidden_field_keys_for_modules): a
-- field under a Hidden tab is a hidden column unless it is set on its own —
-- "A hidden field is a hidden column, and it can't be searched or filtered
-- on." That function also stops consulting the retired module grants and
-- reads module access instead.
--
-- One grant map per call (effective_grants: own override over template, per
-- module before global — the lookup `permissions.ts` makes).
-- =============================================================================

create or replace function grant_from_map(m jsonb, p_kind text, p_scope uuid, p_module uuid)
returns permission_level
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    case when p_module is not null then m ->> (p_kind || ':' || p_scope::text || ':' || p_module::text) end,
    m ->> (p_kind || ':' || p_scope::text)
  )::permission_level;
$$;

create or replace function field_level_from_map(m jsonb, p_field uuid, p_tab uuid, p_subtab uuid, p_module uuid)
returns permission_level
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    grant_from_map(m, 'field', p_field, p_module),
    case when p_subtab is not null then grant_from_map(m, 'subtab', p_subtab, p_module) end,
    grant_from_map(m, 'tab', p_tab, p_module),
    'edit'::permission_level
  );
$$;

create or replace function user_record_field_grant(u uuid, rec uuid, p_field_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when user_is_admin(u) then 'edit'::permission_level
    else (
      select case
        -- Team picker fields need "Add / remove team members" to change.
        when f.type = 'team_member' and user_perm(u, 'action.team') <> 'yes'
          then least(g.level, 'view'::permission_level)
        else g.level
      end
      from fields f
      cross join (select effective_grants(u) as m) gm
      cross join lateral (
        select coalesce(max(field_level_from_map(gm.m, f.id, f.tab_id, f.subtab_id, m.id)), 'hidden'::permission_level) as level
          from modules m
         where (m.kind = 'storage'
                or exists (select 1 from record_modules rm where rm.record_id = rec and rm.module_id = m.id))
           and user_module_scope(u, m.id) <> 'hidden'
      ) g
      where f.key = p_field_key
    )
  end;
$$;

create or replace function user_record_scope_grant(u uuid, rec uuid, p_kind grant_scope, p_scope uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when user_is_admin(u) then 'edit'::permission_level
    when p_kind = 'subtab' then coalesce((
      select max(coalesce(grant_from_map(gm.m, 'subtab', p_scope, m.id), grant_from_map(gm.m, 'tab', s.tab_id, m.id), 'edit'::permission_level))
        from subtabs s
        cross join (select effective_grants(u) as m) gm
        cross join modules m
       where s.id = p_scope
         and (m.kind = 'storage'
              or exists (select 1 from record_modules rm where rm.record_id = rec and rm.module_id = m.id))
         and user_module_scope(u, m.id) <> 'hidden'
    ), 'hidden'::permission_level)
    else coalesce((
      select max(effective_grant(u, p_kind, p_scope, m.id))
        from modules m
       where (m.kind = 'storage'
              or exists (select 1 from record_modules rm where rm.record_id = rec and rm.module_id = m.id))
         and user_module_scope(u, m.id) <> 'hidden'
    ), 'hidden'::permission_level)
  end;
$$;

create or replace function hidden_field_keys_for_modules(p_modules uuid[])
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Set-based (it runs once per row of the list view): the grant map is
  -- unpacked into rows once, then hash-joined to the fields — the same
  -- precedence as field_level_from_map, without per-field JSON lookups.
  select case
    when auth_is_admin() then '{}'::text[]
    else coalesce(
      (
        with
          g as materialized (
            select split_part(e.key, ':', 1) as kind,
                   split_part(e.key, ':', 2)::uuid as scope,
                   nullif(split_part(e.key, ':', 3), '')::uuid as module,
                   e.value::permission_level as lvl
              from jsonb_each_text(effective_grants(auth.uid())) e
             where split_part(e.key, ':', 1) in ('field', 'subtab', 'tab')
          ),
          mods as materialized (
            select mm as module_id from unnest(p_modules) as mm where user_module_scope(auth.uid(), mm) <> 'hidden'
          ),
          per_field as (
            select f.id,
                   max(coalesce(fm.lvl, fg.lvl, sm.lvl, sg.lvl, tm.lvl, tg.lvl, 'edit'::permission_level)) as grant_level
              from fields f
              cross join mods
              left join g fm on fm.kind = 'field'  and fm.scope = f.id        and fm.module = mods.module_id
              left join g fg on fg.kind = 'field'  and fg.scope = f.id        and fg.module is null
              left join g sm on sm.kind = 'subtab' and sm.scope = f.subtab_id and sm.module = mods.module_id
              left join g sg on sg.kind = 'subtab' and sg.scope = f.subtab_id and sg.module is null
              left join g tm on tm.kind = 'tab'    and tm.scope = f.tab_id    and tm.module = mods.module_id
              left join g tg on tg.kind = 'tab'    and tg.scope = f.tab_id    and tg.module is null
             group by f.id
          )
        select array_agg(f.key::text)
          from fields f
          left join per_field p on p.id = f.id
         -- No module the person can open → no row → hidden, as before.
         where coalesce(p.grant_level, 'hidden'::permission_level) = 'hidden'
      ),
      '{}'::text[]
    )
  end;
$$;

create or replace function hidden_field_keys()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then '{}'::text[]
    else coalesce(
      (select array_agg(f.key::text)
         from fields f
         cross join (select effective_grants(auth.uid()) as m) gm
        where field_level_from_map(gm.m, f.id, f.tab_id, f.subtab_id, null) = 'hidden'),
      '{}'::text[]
    )
  end;
$$;
