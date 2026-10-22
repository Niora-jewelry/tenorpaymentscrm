-- =============================================================================
-- Seasonal (Application → General): the client asked for a "No" option beside
-- the twelve months (22 Oct 2026). "No" is stored in the same array as the
-- months (`["No"]`) and kept exclusive by the editor, so nothing else changes.
-- Only the field's hint needs to say so. Seed-only data: the seed has long
-- been applied, so this is an UPDATE, not a reseed.
-- =============================================================================

update public.fields
   set hint = 'Choose No, or the months the business is seasonal. Add a note if needed.'
 where key = 'seasonal'
   and hint = 'Ability to choose up to 12 months and add a note.';
