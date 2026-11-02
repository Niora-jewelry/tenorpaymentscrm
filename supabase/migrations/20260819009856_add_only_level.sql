-- =============================================================================
-- Add only (client spec of 1 Nov 2026): a new permission level for the Logins and
-- Files tabs. It goes before 'view' because the enum's order is the rank:
-- hidden < add_only < view < edit, and `max`/`least` over it are used throughout.
--
-- On its own migration: a new enum value can't be used in the transaction that
-- adds it.
-- =============================================================================

alter type permission_level add value if not exists 'add_only' before 'view';

alter table tabs add column if not exists allows_add_only boolean not null default false;
update tabs set allows_add_only = true where kind in ('logins', 'files');
