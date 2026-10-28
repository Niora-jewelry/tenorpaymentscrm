-- =============================================================================
-- The six user types (Permissions spec) are permanent.
--
-- Everyone has exactly one user type, the resolver falls back to it for every
-- setting, and `perm_assign_type` derives the role from it. Deleting one, or
-- changing which type a row IS, would silently move everyone on it to "most
-- restrictive" or to the wrong role. The admin screen does not offer either;
-- this makes it a rule rather than a missing button. Renaming stays allowed.
-- =============================================================================

create or replace function permission_templates_keep_user_types()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'The % user type cannot be deleted.', old.label using errcode = '42501';
    end if;
    return old;
  end if;
  if old.user_type is distinct from new.user_type or old.is_system is distinct from new.is_system then
    raise exception 'A user type cannot be changed into another one.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists permission_templates_keep_user_types on permission_templates;
create trigger permission_templates_keep_user_types
  before update or delete on permission_templates
  for each row execute function permission_templates_keep_user_types();
