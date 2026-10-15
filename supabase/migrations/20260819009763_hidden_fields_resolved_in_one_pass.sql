-- =============================================================================
-- Hidden-field resolution in one pass, and once per row in the filter view.
--
-- Follows …9762, which took a member's Contacts page from 8.2s (over the 8s
-- statement timeout) to about 1s by computing the hidden-field list once per
-- module set instead of three times per record. Two things were still slow
-- enough to come back as the CRM grows:
--
--   1. One list still cost ~300ms: 134 fields × each module × a call to
--      `effective_grant`, a SECURITY DEFINER function — so never inlined, and
--      each call running four lookups of its own.
--
--   2. `records_filterable` (the view a saved filter queries) still called
--      `hidden_field_keys_for_record` THREE times per row in its `values`
--      expression. With a member's saved filter on a field value, that runs
--      for every row in the module: ~74ms a row, so a module of a hundred-odd
--      records would hit the timeout again.
--
-- ── 1. THE FIELD GRANTS, LOOKED UP ONCE ──────────────────────────────────
-- `effective_grant(u, 'field', f, m)` is a fixed precedence:
--     user override for module m → user override everywhere
--   → template grant for module m → template grant everywhere → 'edit'.
-- The user's field overrides and their template's field grants are read ONCE
-- into two small sets, and the same four-step precedence is applied per field
-- and module against those sets. Same answer, without 134 × modules function
-- calls. The MODULE grant still goes through `effective_grant` unchanged —
-- there are only as many of those as modules.
--
-- `user_templates` is keyed by user_id (one template per user) and grants are
-- unique per (user/template, scope, module), so each step finds at most one
-- row — exactly what the scalar subqueries in `effective_grant` assume.
--
-- ── 2. THE VIEW COMPUTES THE LIST ONCE PER ROW ───────────────────────────
-- Same columns, same order, same types, same `security_invoker = false`; the
-- list is computed in a scalar subquery and reused for all three uses. A
-- scalar subquery in the select list is only evaluated when `values` is
-- actually referenced — the unfiltered table query never touches it, same as
-- before.
--
-- ── EQUIVALENCE ──────────────────────────────────────────────────────────
-- Proven, not assumed: the hidden-field list for every profile × every record
-- and the visible `values` for every profile were snapshotted from the
-- ORIGINAL functions before …9762, and compared byte for byte after each
-- migration.
-- =============================================================================

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
        with
          mods as (
            select mm as module_id,
                   effective_grant(auth.uid(), 'module'::grant_scope, mm, null) as module_grant
              from unnest(p_modules) as mm
          ),
          -- The user's own field overrides, and their template's field grants.
          own as (
            select ug.scope_id, ug.module_id, ug.grant_level
              from user_grants ug
             where ug.user_id = auth.uid() and ug.scope_kind = 'field'::grant_scope
          ),
          tpl as (
            select tg.scope_id, tg.module_id, tg.grant_level
              from user_templates ut
              join template_grants tg on tg.template_id = ut.template_id
             where ut.user_id = auth.uid() and tg.scope_kind = 'field'::grant_scope
          ),
          -- record_scope_grant: max across modules of least(module, field).
          per_field as (
            select f.id,
                   max(least(
                     m.module_grant,
                     coalesce(
                       (select o.grant_level from own o where o.scope_id = f.id and o.module_id = m.module_id),
                       (select o.grant_level from own o where o.scope_id = f.id and o.module_id is null),
                       (select t.grant_level from tpl t where t.scope_id = f.id and t.module_id = m.module_id),
                       (select t.grant_level from tpl t where t.scope_id = f.id and t.module_id is null),
                       'edit'::permission_level
                     )
                   )) as grant_level
              from fields f
              cross join mods m
             group by f.id
          )
        select array_agg(f.key::text)
          from fields f
          left join per_field p on p.id = f.id
         -- No module at all → no row in per_field → 'hidden', as before.
         where coalesce(p.grant_level, 'hidden'::permission_level) = 'hidden'
      ),
      '{}'::text[]
    )
  end;
$$;

create or replace view records_filterable
with (security_invoker = false)
as
select r.id,
       r.deal_name,
       r.creator_kind,
       r.creator_user_id,
       r.creator_campaign_id,
       r.created_at,
       r.updated_at,
       r.deleted_at,
       (select (r."values" - k.keys)
               || case
                    when 'deal_name' = any(k.keys) then '{}'::jsonb
                    else jsonb_build_object('deal_name', r.deal_name)
                  end
               || case
                    when 'record_creator' = any(k.keys)
                      or r.creator_kind <> 'user'::creator_kind
                      or r.creator_user_id is null
                      then '{}'::jsonb
                    else jsonb_build_object('record_creator', jsonb_build_array(r.creator_user_id::text))
                  end
          from (select hidden_field_keys_for_record(r.id) as keys) k) as "values",
       coalesce((select array_agg(rm.module_id) from record_modules rm where rm.record_id = r.id),
                '{}'::uuid[]) as module_ids
  from records r
 where record_visible(r.id);
