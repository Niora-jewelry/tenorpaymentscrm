-- Client review, 6 Nov 2026.
--
-- The Files buttons name the two agreements as the client does: Acquiring
-- agreement and ACH agreement. The keys do not change.
update agreement_kinds set label = 'Acquiring agreement' where key = 'maverick_merchant';
update agreement_kinds set label = 'ACH agreement' where key = 'maverick_ach';

-- "The Teams tab is placeholder for now." `coming_soon` was already true and
-- `shows_record_chats` was winning over it, so this hands the sub-tab back to the
-- placeholder. Setting the flag again brings the chats panel back; the chats and
-- their links are untouched.
update subtabs set shows_record_chats = false where shows_record_chats and coming_soon;

-- The PDF of the application is hidden for now (`lib/applications/offer.ts`), so
-- the email stops offering it. Only the shipped sentence goes: an admin's own
-- wording in Presets stays as they wrote it.
update application_settings
   set email_body = replace(
         email_body,
         E'Prefer paper? Fill in the attached PDF on your computer and send it back to us, or upload it on the same page.\n\n',
         '');
