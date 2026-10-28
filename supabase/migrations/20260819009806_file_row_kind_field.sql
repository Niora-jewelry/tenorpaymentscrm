-- =============================================================================
-- UI/UX Redesign spec §4: "Files — Attach / view files" as a field type.
-- A Files field keeps its uploads in a file row of a new kind, `field`.
-- Its own migration: Postgres cannot use an enum value in the transaction
-- that adds it; 9807 puts it to work.
-- =============================================================================
alter type file_row_kind add value if not exists 'field';
