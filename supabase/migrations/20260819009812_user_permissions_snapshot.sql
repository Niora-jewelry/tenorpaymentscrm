-- =============================================================================
-- Permissions spec — part 3: one read per request.
--
-- The application asks many small questions ("may they archive?", "is Leads
-- Only mine?", "may they open Presets?"). Each would be a round trip; instead
-- the server reads the caller's whole resolved set once, through the same
-- resolver the policies use (user_perm, user_module_scope), so the screen and
-- the database can never disagree about a setting.
-- =============================================================================

create or replace function user_permissions(u uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'superAdmin', user_is_admin(u),
    'userType', (select pt.user_type from user_templates ut join permission_templates pt on pt.id = ut.template_id where ut.user_id = u),
    'settings', (
      select jsonb_object_agg(k, user_perm(u, k))
        from unnest(array[
          'action.create', 'action.team', 'action.archive', 'action.modules', 'action.pipeline',
          'notifications.scope', 'email.scope', 'phone.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes'
        ]) as k
    ),
    'modules', (select coalesce(jsonb_object_agg(m.id::text, user_module_scope(u, m.id)), '{}'::jsonb) from modules m)
  );
$$;

create or replace function my_permissions()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_permissions(auth.uid());
$$;

revoke execute on function user_permissions(uuid) from public, anon, authenticated;
revoke execute on function my_permissions() from public, anon;
grant execute on function my_permissions() to authenticated;
