-- =============================================================================
-- Module 2 — Part 17: fix pgp_sym_encrypt/decrypt — wrong schema
--
-- FOUND BY: the smoke test, calling store_login_password() for real —
-- "function pgp_sym_encrypt(text, text) does not exist". This Supabase
-- project installs pgcrypto into the `extensions` schema (Supabase's own
-- default, per supabase/config.toml's `extra_search_path`), not `public`.
-- store_login_password()/reveal_password() pin `search_path = public,
-- pg_temp` — deliberately, to close the search-path-hijack class the auth
-- module's own header comment calls out — so widening the search_path to add
-- `extensions` would blunt that guarantee for every unqualified identifier in
-- the function, not just this one call. Schema-qualifying the two calls is
-- more precise: nothing else in the function becomes resolvable from a wider
-- path, only these two specific, known-safe functions.
-- =============================================================================

create or replace function store_login_password(
  p_login_id    uuid,
  p_plaintext   text,
  p_key         text,
  p_key_version text default 'v1'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid;
begin
  select record_id into v_record from logins where id = p_login_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  update logins
     set password_enc = extensions.pgp_sym_encrypt(p_plaintext, p_key),
         password_key = p_key_version
   where id = p_login_id;
end;
$$;

create or replace function reveal_password(p_login_id uuid, p_key text)
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
  select record_id, password_enc, login_type into v_record, v_enc, v_type
    from logins where id = p_login_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  insert into credential_reveals (login_id, user_id) values (p_login_id, auth.uid());
  insert into record_activity (record_id, actor_id, kind, summary)
  values (v_record, auth.uid(), 'credential', format('Revealed the %s password', v_type));

  return extensions.pgp_sym_decrypt(v_enc, p_key);
end;
$$;
