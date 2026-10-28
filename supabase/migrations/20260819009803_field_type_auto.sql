-- =============================================================================
-- UI/UX Redesign spec §4: a new field type, "Auto-populated (locked)" —
-- "Filled in automatically by the system; staff can't edit it (e.g. Record
-- creator, Merchant industry from MCC)."
--
-- Its own migration because Postgres cannot use an enum value in the
-- transaction that adds it; 9804 puts it to work.
-- =============================================================================
alter type field_type add value if not exists 'auto';
