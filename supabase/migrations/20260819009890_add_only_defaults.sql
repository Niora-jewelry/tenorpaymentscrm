-- =============================================================================
-- The Add only spec's defaults: everyone full access to Logins and Files, except
-- Sales agents and Reconcilers, who start on Add only for Logins.
--
-- 9857 set these too, and they were put back by hand the same day: the database
-- is shared with the deployed sites, and code that doesn't know the Add only
-- level can't draw it. Apply this once the code that does is live.
-- =============================================================================

update template_grants g
   set grant_level = case
         when t.key = 'logins' and pt.user_type in ('sales_agent', 'accounting') then 'add_only'::permission_level
         else 'edit'::permission_level
       end
  from tabs t, permission_templates pt
 where g.scope_kind = 'tab' and g.module_id is null
   and g.scope_id = t.id and t.key in ('logins', 'files')
   and g.template_id = pt.id and pt.user_type is not null;
