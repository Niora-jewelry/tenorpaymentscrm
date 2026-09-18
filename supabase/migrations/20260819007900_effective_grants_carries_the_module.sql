-- =============================================================================
-- Part 79: `effective_grants(u)` carries the module in its keys.
--
-- ── WHY THIS HAD TO CHANGE ───────────────────────────────────────────────
-- The app resolves grants from a per-request map built by this function, keyed
-- `"<kind>:<scope_id>"`. With grants now per module, that key cannot tell a
-- global grant from a Deals-only one — they collide, `distinct on` keeps
-- whichever sorted first, and a per-module override would be applied everywhere
-- or nowhere at random.
--
-- Keys are now `"<kind>:<scope_id>"` for a global grant and
-- `"<kind>:<scope_id>:<module_id>"` for a module-specific one, so the reader
-- can look for the specific key first and fall back to the general one — the
-- same order `effective_grant()` applies in SQL.
--
-- ── PRECEDENCE IS UNCHANGED ──────────────────────────────────────────────
-- Rank 0 is the user's own grant, rank 1 the template's, and `distinct on`
-- keeps the lowest rank per key. That is §2.4's "user override if one exists,
-- otherwise the template value", and it stays exactly as it was — the module
-- only widens the key, it does not reorder anything.
-- =============================================================================

create or replace function public.effective_grants(u uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(
      x.scope_kind::text || ':' || x.scope_id::text
        || case when x.module_id is null then '' else ':' || x.module_id::text end,
      x.grant_level
    ),
    '{}'::jsonb
  )
  from (
    select distinct on (g.scope_kind, g.scope_id, g.module_id)
           g.scope_kind, g.scope_id, g.module_id, g.grant_level
      from (
        -- Rank 0: the user's own override. Always wins.
        select ug.scope_kind, ug.scope_id, ug.module_id, ug.grant_level, 0 as source_rank
          from user_grants ug
         where ug.user_id = u

        union all

        -- Rank 1: whatever this user's template pins. At most one template per
        -- user (PK on user_templates.user_id), so this contributes at most one
        -- row per scope-and-module.
        select tg.scope_kind, tg.scope_id, tg.module_id, tg.grant_level, 1 as source_rank
          from user_templates ut
          join template_grants tg on tg.template_id = ut.template_id
         where ut.user_id = u
      ) g
     order by g.scope_kind, g.scope_id, g.module_id, g.source_rank
  ) x;
$$;
