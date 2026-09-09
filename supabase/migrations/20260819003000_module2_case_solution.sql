-- =============================================================================
-- Module 2 — Part 30: set_case_solution — a real gap found while building the
-- Cases UI, plus a manager-only tightening on toggle_case_state.
--
-- FOUND WHILE BUILDING: the prototype's own CasesTab shows "Write the
-- solution" only to an assigned ticket manager (`isManager`), and only a
-- manager can close/reopen a case. But no `set_case_solution()` function
-- existed at all — only `admin_edit_case()` (admin-only) can touch the
-- `solution` column — so a non-admin manager, exactly the person the
-- prototype's UI is built for, had no real way to do the one thing their
-- role exists for. And `toggle_case_state()` never checked manager status
-- server-side in the first place — it only checked `record_visible()`, so
-- ANY teammate who can see the record could close or reopen a case, with
-- nothing but the client's `disabled={!isManager}` in the way. Same category
-- of bug as delete_record/restore_record's missing checks and notes' missing
-- author check — the UI hiding a control is convenience, not the boundary.
-- =============================================================================

create or replace function set_case_solution(p_case_id uuid, p_solution text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid;
begin
  select record_id into v_record from cases where id = p_case_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if not auth_is_admin() and not exists (
    select 1 from case_managers where case_id = p_case_id and user_id = auth.uid()
  ) then
    raise exception 'Only an assigned ticket manager may write the solution' using errcode = '42501';
  end if;

  update cases set solution = p_solution, solution_author = auth.uid(), solution_at = now()
   where id = p_case_id;

  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'case', 'Solution written');
end;
$$;

create or replace function toggle_case_state(p_case_id uuid, p_close boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid;
begin
  select record_id into v_record from cases where id = p_case_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  if not auth_is_admin() and not exists (
    select 1 from case_managers where case_id = p_case_id and user_id = auth.uid()
  ) then
    raise exception 'Only an assigned ticket manager may change the case state' using errcode = '42501';
  end if;

  if p_close then
    update cases set state = 'closed' where id = p_case_id and solution is not null;
    if not found then
      raise exception 'A case cannot be closed until its Solution has been written'
        using errcode = '23514';
    end if;
    insert into record_activity (record_id, actor_id, kind, summary)
    values (v_record, auth.uid(), 'case', 'Case closed');
  else
    update cases set state = 'open' where id = p_case_id;
    insert into record_activity (record_id, actor_id, kind, summary)
    values (v_record, auth.uid(), 'case', 'Case reopened');
  end if;
end;
$$;

revoke all on function set_case_solution(uuid, text) from public, anon, authenticated;
grant execute on function set_case_solution(uuid, text) to authenticated;
