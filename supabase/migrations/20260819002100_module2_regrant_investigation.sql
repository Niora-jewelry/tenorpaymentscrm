-- Diagnostic: revoke-only, no CREATE OR REPLACE in this file, to isolate
-- whether mixing DDL (function redefinition) with GRANT/REVOKE in the same
-- migration is what's letting the grant reappear.
--
-- CONFIRMED the theory for these two: this migration is already applied and
-- its effect held on re-check (delete_record/restore_record correctly show
-- no anon grant afterward), unlike the combined create-or-replace-plus-grant
-- migration that preceded it. Left in place, not deleted, even though it's
-- a diagnostic — this file is already recorded as applied in the remote
-- migration history; removing it locally would desync that history without
-- undoing its already-live effect.
revoke execute on function delete_record(uuid), restore_record(uuid) from public, anon, authenticated;
grant  execute on function delete_record(uuid), restore_record(uuid) to authenticated;
