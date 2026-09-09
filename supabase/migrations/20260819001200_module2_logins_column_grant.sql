-- =============================================================================
-- Module 2 — Part 12: logins column-level SELECT, done the way that actually
-- works
--
-- FOUND BY: verify-schema.mjs querying has_column_privilege() directly rather
-- than trusting information_schema — `password_enc`/`password_key` were still
-- selectable by authenticated after migration 9's
-- `revoke select (password_enc, password_key) on logins from authenticated`.
--
-- WHY THE REVOKE DID NOTHING: Postgres represents table-level and column-level
-- privileges as genuinely separate ACL entries (pg_class.relacl vs
-- pg_attribute.attacl). A table-level `GRANT SELECT` implicitly covers every
-- column; a *column-level* REVOKE only removes a column-level grant, which
-- never existed here — the SELECT the role has comes entirely from the
-- table-level grant migration 9 also issued in the same statement (the bulk
-- `grant select, insert, update, delete on ..., logins ... to authenticated`).
-- Revoking a column privilege that isn't the source of the access is a no-op;
-- `has_column_privilege()` still says yes because the TABLE-level grant alone
-- is sufficient. The only way to actually narrow this is the reverse
-- direction: revoke the table-level SELECT entirely, then grant SELECT on an
-- explicit column ALLOW-LIST that excludes the two encrypted columns — the
-- same shape `profiles.full_name`'s column-restricted UPDATE already uses in
-- the auth migration.
-- =============================================================================

revoke select, insert, update on logins from authenticated, anon;

grant select (
  id, record_id, login_type, link, username, note, position, deleted_at
) on logins to authenticated;

-- INSERT/UPDATE narrowed the same way: a client creates or edits a login's
-- metadata directly, but never writes password_enc/password_key itself —
-- that column pair is written exclusively by store_login_password(), so a
-- ciphertext value is never anything other than what pgp_sym_encrypt() with
-- the real key actually produced.
grant insert (
  id, record_id, login_type, link, username, note, position
) on logins to authenticated;

grant update (
  login_type, link, username, note, position, deleted_at
) on logins to authenticated;
