-- =============================================================================
-- Module 2 — Part 59: three new `file_row_kind` values, and nothing else.
--
-- Modules Plan §3.7: "Files. Files can be attached to the Issue, to the
-- Solution, and to individual replies. Standard file limits apply (up to 5 files
-- per attachment point, 25MB per file), stored and versioned like all files."
--
-- "Like all files" is the design instruction, and it is worth taking literally:
-- a case attachment is a `files` row under a `file_rows` row, exactly like an
-- Application document. That inherits, at no cost and with no second
-- implementation to keep in step:
--
--   * the five-per-row cap (`files_cap_guard`, migration 4);
--   * the 25MB ceiling (a CHECK on `files.size_bytes`);
--   * versioning — a replacement adds a row and the list IS the history;
--   * `delete_file`, `restore_file`, and therefore the Recycle Bin;
--   * `record_file_upload`, and therefore the activity log entry §3.7 also asks
--     for ("every file attachment … written to the record's activity log").
--
-- ── WHY THIS IS ITS OWN MIGRATION ────────────────────────────────────────
-- `ALTER TYPE … ADD VALUE` cannot be used in the same transaction that adds it:
-- Postgres raises "unsafe use of new value of enum type". Migration 60 uses
-- these three, so they have to be committed first. Splitting the pair is not
-- tidiness — it is the only order that runs.
-- =============================================================================

alter type file_row_kind add value if not exists 'case_issue';
alter type file_row_kind add value if not exists 'case_solution';
alter type file_row_kind add value if not exists 'case_reply';
