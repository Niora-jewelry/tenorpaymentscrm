begin;

-- ════════════════════════════════════════════════════════════════════════
-- The Files tab is one list again
-- ════════════════════════════════════════════════════════════════════════
--
-- The tab carried two subtabs: "Application files", a fixed checklist of five
-- locked rows seeded by `ensure_application_rows`, and "Other files", which
-- existed for one reason — Application could not take a new row, so anything
-- that was not one of the five had nowhere else to go.
--
-- Application takes rows now (see `addFileRow`), so the second subtab is a
-- second place to look for the same thing. The client asked for it to go.
--
-- ── THE ROWS MOVE, THEY ARE NOT ORPHANED ────────────────────────────────
-- Dropping the subtab alone would leave every `kind = 'other'` row reachable
-- by nothing: still stored, still holding its files, and absent from the only
-- screen that lists them. So they are migrated first, in the same
-- transaction.
--
-- They arrive UNLOCKED, which is what they already were. `locked` marks the
-- seeded structure whose names other people rely on; a row somebody typed is
-- not that, and the five seeded ones keep their lock.
--
-- Measured before writing this: one live `other` row exists, named "test",
-- holding no files. The migration does not lean on that — it moves whatever
-- is there, because the next database this runs against will not be this one.

update public.file_rows
   set kind = 'application',
       locked = false
 where kind = 'other'
   and deleted_at is null;

-- ── THE SUBTAB GOES BY CONFIGURATION, NOT BY DELETION ───────────────────
-- `subtabs` has no `deleted_at`, and the row is pointed at by `fields` and
-- `user_field_order`. Removing it outright would be a hard delete of
-- configuration to hide one chip — so what is removed is its MEMBERSHIP:
-- `module_subtab_order` is the per-module list of which subtabs a tab shows,
-- and the same table is how a tab is removed from one module without
-- touching the tab itself.
--
-- ⚠️ THE `application` ROWS MUST SURVIVE, AND THAT IS NOT COSMETIC.
-- `subtabsForModule` falls back to EVERY subtab on the tab when a module has
-- no order rows for it:
--
--     return ordered.length ? ordered : config.subtabs.filter(...)
--
-- Deleting both would therefore bring "Other files" straight back through the
-- fallback, which is the opposite of what this migration is for. Verified
-- before writing: all six modules carry an `application` row at position 0,
-- so each is left with exactly one and the fallback is never reached.
--
-- Checked too: no `fields` and no `user_field_order` rows point at this
-- subtab, so nothing is stranded by its disappearance from the strip.

delete from public.module_subtab_order mso
 using public.subtabs s, public.tabs t
 where mso.subtab_id = s.id
   and s.tab_id = t.id
   and t.key = 'files'
   and s.key = 'other';

commit;
