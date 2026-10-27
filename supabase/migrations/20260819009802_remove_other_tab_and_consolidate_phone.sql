-- =============================================================================
-- UI/UX Redesign spec §5 — the Other tab and the Communication tab.
--
-- Backed up first: backups/izzy-2026-10-27/other-tab-entries.csv holds every
-- Other-tab row (scripts/export-izzy-backup.mjs).
--
-- ── OTHER TAB ────────────────────────────────────────────────────────────────
-- "Remove the tab entirely from every module. It is a per-record Label /
-- Information list and holds no data worth keeping, so it is deleted." The
-- tab row, its storage, its three writer functions and its grants all go.
-- No admin can create another tab of this kind (new tabs are always `custom`),
-- so nothing is left to point at them. The `custom_entry` activity kind stays:
-- history rows already written with it are append-only and keep their meaning.
--
-- ── COMMUNICATION ────────────────────────────────────────────────────────────
-- Sub-tabs today: Email · Phone · Text · Teams · Instantly · Call recordings.
-- After:          Email · Phone · Teams.
--   * Text and Call recordings are not deleted — their content now sits under
--     Phone, behind a Calls | Texts | Call recordings toggle. Only the two
--     sub-tab rows go. Grants set on them go too: the Permissions spec makes
--     Communication one setting that every sub-tab follows.
--   * Instantly: the sub-tab goes, and so does the integration — nothing may
--     write an Instantly message again. There are none (0 rows), so the guard
--     is validated immediately.
-- =============================================================================

-- ── Other tab ──────────────────────────────────────────────────────────────────
drop function if exists add_custom_entry(uuid, text, text);
drop function if exists update_custom_entry(uuid, text, text);
drop function if exists delete_custom_entry(uuid);
drop table if exists record_custom_entries;

delete from template_grants g using tabs t
 where t.key = 'other' and g.scope_kind = 'tab' and g.scope_id::text = t.id::text;
delete from user_grants g using tabs t
 where t.key = 'other' and g.scope_kind = 'tab' and g.scope_id::text = t.id::text;
delete from invite_grants g using tabs t
 where t.key = 'other' and g.scope_kind = 'tab' and g.scope_id::text = t.id::text;
delete from notes n using tabs t
 where t.key = 'other' and n.scope_kind = 'tab'
   and (n.scope_id = t.id::text or n.scope_id like t.id::text || '/%');
-- module_tab_order and user_field_order cascade.
delete from tabs where key = 'other' and kind = 'freeform';

-- ── Communication: Text and Call recordings move under Phone ──────────────────
-- A tab note left on either sub-tab follows its content to Phone.
update notes n
   set scope_id = c.id::text || '/' || p.id::text
  from tabs c
  join subtabs p on p.tab_id = c.id and p.key = 'phone'
  join subtabs gone on gone.tab_id = c.id and gone.key in ('text', 'recordings', 'instantly')
 where c.key = 'communication'
   and n.scope_kind = 'tab'
   and n.scope_id = c.id::text || '/' || gone.id::text;

delete from template_grants g using subtabs s join tabs c on c.id = s.tab_id and c.key = 'communication'
 where s.key in ('text', 'recordings', 'instantly') and g.scope_kind = 'subtab' and g.scope_id::text = s.id::text;
delete from user_grants g using subtabs s join tabs c on c.id = s.tab_id and c.key = 'communication'
 where s.key in ('text', 'recordings', 'instantly') and g.scope_kind = 'subtab' and g.scope_id::text = s.id::text;
delete from invite_grants g using subtabs s join tabs c on c.id = s.tab_id and c.key = 'communication'
 where s.key in ('text', 'recordings', 'instantly') and g.scope_kind = 'subtab' and g.scope_id::text = s.id::text;

-- module_subtab_order and user_field_order cascade.
delete from subtabs s using tabs c
 where c.id = s.tab_id and c.key = 'communication' and s.key in ('text', 'recordings', 'instantly');

-- Email · Phone · Teams, in that order.
update subtabs s set position = v.pos
  from tabs c, (values ('email', 0), ('phone', 10), ('teams', 20)) as v(key, pos)
 where c.id = s.tab_id and c.key = 'communication' and s.key = v.key;

-- ── Instantly: the integration is off ──────────────────────────────────────────
alter table messages
  add constraint messages_no_instantly check (channel <> 'instantly');
comment on constraint messages_no_instantly on messages is
  'UI/UX Redesign spec §5: the Instantly integration is turned off. The enum value stays only because Postgres cannot drop one; no row may use it.';
