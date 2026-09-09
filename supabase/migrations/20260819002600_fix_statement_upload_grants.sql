-- =============================================================================
-- Module 2 — Part 26: re-apply the statement-upload grants in isolation.
--
-- Same root cause documented in migration 21/22: mixing CREATE FUNCTION with
-- REVOKE/GRANT in one migration (migration 25) left `anon` still executable
-- via the default PUBLIC grant, confirmed by has_function_privilege() right
-- after the push. Pure revoke/grant, zero other DDL, so nothing re-widens it.
-- =============================================================================

revoke all on function statement_file_upload(uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function delete_statement_file(uuid) from public, anon, authenticated;

grant execute on function statement_file_upload(uuid, uuid, text, text, bigint) to authenticated;
grant execute on function delete_statement_file(uuid) to authenticated;
