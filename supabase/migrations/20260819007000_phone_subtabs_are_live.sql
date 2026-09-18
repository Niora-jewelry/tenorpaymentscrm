-- =============================================================================
-- Part 70: Phone and Call recordings are no longer "coming soon".
--
-- ── WHY THIS IS A MIGRATION AND NOT A CODE CHANGE ────────────────────────
-- `communication/phone` and `communication/recordings` were seeded
-- `coming_soon = true` because no provider was wired. Twilio now is: both
-- subtabs render real calls, recordings and voicemail.
--
-- When that landed, `CommunicationPanel` was made to check the subtab key
-- BEFORE the `comingSoon` flag, which rendered the real panels regardless of
-- what the database said. That worked, and it was wrong in a way this project
-- has a rule about: it put the decision in code, where an admin cannot reach
-- it. Switching a subtab off is configuration (CLAUDE.md rule 1), and the
-- bypass quietly took that away — an admin could set Phone back to
-- `coming_soon` and the screen would ignore them.
--
-- So the flag is corrected here, at its source, and the bypass is removed in
-- the same change. The database goes back to being the only thing that decides.
--
-- ⚠ `teams` is deliberately untouched. There is no Teams provider, so that one
-- is still genuinely coming soon and its flag is still telling the truth.
-- =============================================================================

update subtabs s
   set coming_soon = false
  from tabs t
 where t.id = s.tab_id
   and t.key = 'communication'
   and s.key in ('phone', 'recordings')
   and s.coming_soon;
