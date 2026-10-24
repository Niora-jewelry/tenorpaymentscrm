-- =============================================================================
-- Delete a permission template, moving the people on it to another one
-- =============================================================================
-- Client request, 24 Oct 2026: "I should be able to click Delete and assign
-- users to a different template." Until now Delete was only offered on a
-- template nobody was on.
--
-- One function, so the move and the delete are one transaction: nobody can be
-- left pointing at a template that is gone, and nobody is ever left with NO
-- template by accident — a NULL template means "unset scopes resolve to
-- Edit", i.e. full access, so moving people to nothing is refused outright.
--
-- Only `user_templates.template_id` changes. A person's own overrides
-- (`user_grants`) are theirs and are left exactly as they are; the template's
-- own grants cascade away with it.
--
-- SECURITY DEFINER with `search_path` pinned (CLAUDE.md §8); callable by
-- `authenticated`, refused inside for anyone who is not an admin.
-- =============================================================================

create or replace function public.delete_permission_template(p_template_id uuid, p_move_to uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_moved integer := 0;
  v_users integer;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  -- Lock the template so nobody is attached to it between the count and the delete.
  perform 1 from permission_templates where id = p_template_id for update;
  if not found then
    raise exception 'That template no longer exists — reload the page.' using errcode = 'P0002';
  end if;

  select count(*) into v_users from user_templates where template_id = p_template_id;

  if v_users > 0 then
    if p_move_to is null then
      raise exception 'Pick a template to move its % user% to.', v_users, case when v_users = 1 then '' else 's' end
        using errcode = '22023';
    end if;
    if p_move_to = p_template_id then
      raise exception 'Pick a different template to move them to.' using errcode = '22023';
    end if;
    perform 1 from permission_templates where id = p_move_to for share;
    if not found then
      raise exception 'The template to move them to no longer exists — reload the page.' using errcode = 'P0002';
    end if;

    update user_templates set template_id = p_move_to where template_id = p_template_id;
    get diagnostics v_moved = row_count;
  end if;

  delete from permission_templates where id = p_template_id;
  return v_moved;
end;
$$;

revoke all on function public.delete_permission_template(uuid, uuid) from public, anon;
grant execute on function public.delete_permission_template(uuid, uuid) to authenticated;
