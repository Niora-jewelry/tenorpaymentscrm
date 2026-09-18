-- =============================================================================
-- Part 73: the three policies migration 72 missed.
--
-- ── WHY 72 DID NOT FINISH THE JOB ────────────────────────────────────────
-- Migration 72 added a tab test to every policy it knew about, and the retest
-- showed statements correctly returning `[]` — while LOGINS still answered in
-- full with the same browser token.
--
-- The cause is the one thing about Postgres policies that is easy to forget:
-- PERMISSIVE POLICIES ARE OR-ED TOGETHER. Tightening one does nothing while a
-- second still grants the row. `logins` carried three:
--
--     logins_all              record_visible AND tab_visible   (72 fixed this)
--     logins_select_metadata  record_visible                   (still open)
--     logins_write            record_visible                   (still open)
--
-- 72 dropped the two names it expected — `logins_select` and `logins_all` —
-- and never saw the other two. Dropping policies by guessed name is how that
-- happens; this migration was written after ENUMERATING every policy on every
-- affected table and filtering for ones whose expression lacks `tab_visible`.
--
-- ── WHAT IS DELIBERATELY LEFT ALONE ──────────────────────────────────────
-- `statement_periods` also lacks a tab test, on both its policies. That is
-- correct: it is a global list of year/month periods with no `record_id` and no
-- merchant data in it — there is nothing per-record to gate, and its write path
-- is already admin-only.
-- =============================================================================

-- ── logins: metadata reads ───────────────────────────────────────────────
-- The split exists so the encrypted password column is never selectable while
-- the row's metadata is. Both halves must respect the tab: a viewer with
-- Logins = Hidden should not learn that a Processor portal account exists, let
-- alone its username.
drop policy if exists logins_select_metadata on logins;
create policy logins_select_metadata on logins
  for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'logins'));

-- ── logins: writes ───────────────────────────────────────────────────────
-- Writing needs EDIT, not merely "not hidden" — a viewer with Logins = View
-- can read a credential row and must not be able to change it.
drop policy if exists logins_write on logins;
create policy logins_write on logins
  for all to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'logins') = 'edit')
  with check (record_visible(record_id) and record_tab_grant(record_id, 'logins') = 'edit');

-- ── credential_reveals: the audit trail of who looked ────────────────────
-- Gated through the login it belongs to, so it follows the same tab. Reading
-- "Priya revealed the Processor portal password on Tuesday" discloses both the
-- account's existence and who has access to it.
drop policy if exists credential_reveals_select on credential_reveals;
create policy credential_reveals_select on credential_reveals
  for select to authenticated
  using (exists (
    select 1 from logins l
     where l.id = credential_reveals.login_id
       and record_visible(l.record_id)
       and tab_visible(l.record_id, 'logins')
  ));
