-- =============================================================================
-- Permissions spec, Build notes: "Also log when someone views or copies a
-- login." A copy was logged as a reveal, or not at all when the password was
-- already on screen. Each is now its own entry: `credential_reveals.kind` and a
-- history line that says which ("Viewed" / "Copied").
-- =============================================================================
alter table credential_reveals add column if not exists kind text not null default 'view'
  check (kind in ('view', 'copy'));

drop function if exists reveal_password(uuid, text);
create or replace function reveal_password(p_login_id uuid, p_key text, p_kind text default 'view')
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_enc    bytea;
  v_type   text;
begin
  if p_kind not in ('view', 'copy') then raise exception 'Unknown action.'; end if;
  select record_id, password_enc, login_type into v_record, v_enc, v_type
    from logins where id = p_login_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;
  -- Before the audit rows are written: a refused attempt must not leave an
  -- entry in the record's history.
  perform require_tab_view(v_record, 'logins');

  insert into credential_reveals (login_id, user_id, kind) values (p_login_id, auth.uid(), p_kind);
  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'credential',
          format(case p_kind when 'copy' then 'Copied the %s password' else 'Viewed the %s password' end, v_type));

  return extensions.pgp_sym_decrypt(v_enc, p_key);
end;
$$;
revoke execute on function reveal_password(uuid, text, text) from public, anon;
grant execute on function reveal_password(uuid, text, text) to authenticated;
