-- =============================================================================
-- Module 2 — Part 38: a permission template's label is its identity, so it has
-- to be unique.
--
-- Phase 6a (Admin → Templates) is the first thing in this build that can
-- create a `permission_templates` row — the table is EMPTY in the live database
-- (checked 2026-09-05, not assumed), which is also why this index can be added
-- with no backfill or de-duplication step.
--
-- ── WHY THE LABEL, AND NOT JUST THE ID ───────────────────────────────────
-- Nothing outside the database ever shows a template's id. The label is the
-- whole of what an admin sees in both places a template appears:
--
--   * `UsersTable.tsx`'s badge — "Template: Sales rep", the client's own
--     wording (`CLIENT-SPEC-BY-MODULE.md` §8);
--   * the "Assign template…" dropdown on the same screen.
--
-- Two rows labelled "Sales rep" are therefore indistinguishable in both. An
-- admin picks one of two identical options, attaches a user to a grant set that
-- is not the one they were looking at, and every screen afterwards agrees with
-- them: the badge reads "Template: Sales rep", which is true of both. Nothing
-- errors and nothing looks wrong — and once 6c can write grants, the difference
-- between the two is what a user can see. CLAUDE.md: a rule that must never
-- break belongs in the database as well as the code.
--
-- ── WHY CASE-INSENSITIVE ─────────────────────────────────────────────────
-- "Sales rep" and "Sales Rep" are the same option to the person reading the
-- dropdown, which is the only place this distinction is ever made. A unique
-- index on the raw text would allow both and leave exactly the ambiguity above.
-- `lower(label)` rather than a `citext` column type: the same effect, without
-- rewriting a column three other tables reference.
--
-- Labels are trimmed by `adminTemplates.ts` before they arrive, so "Sales rep "
-- cannot slip past this as a distinct value either.
--
-- No delete, in this migration or in Phase 6a's data layer: `template_grants`
-- cascades from here, and `user_templates.template_id` does NOT (it is a plain
-- reference), so removing an attached template fails as a 23503 while removing
-- an unattached one silently discards its whole grant set. That is the same
-- posture migrations 36 and 37 took for choices and steps, for the same reason.
-- =============================================================================

create unique index permission_templates_label_unique
  on permission_templates (lower(label));

comment on index permission_templates_label_unique is
  'The label is a template''s only visible identity (the Users badge and the assign dropdown). Two templates sharing one makes an admin''s choice between them meaningless.';
