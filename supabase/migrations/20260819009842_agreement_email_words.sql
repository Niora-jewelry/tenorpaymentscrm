-- =============================================================================
-- Two agreement kinds now share one email: {{agreement}} says which one it is,
-- so a signer of the ACH agreement is not told it is the merchant agreement.
-- Only the words the defaults shipped with change; other edits are kept.
-- =============================================================================

alter table agreement_settings alter column email_subject set default 'Your {{agreement}} — {{merchant}}';
alter table agreement_settings alter column email_message set default E'Hi {{signer_name}},\n\nPlease review and sign the {{agreement}} for {{merchant}}. Every detail has been filled in from your application; you only need to sign and date where marked.\n\nThe link is valid until {{expires}}.\n\nThanks,\n{{sender_name}}';

update agreement_settings
   set email_subject = replace(email_subject, 'Your merchant agreement', 'Your {{agreement}}'),
       email_message = replace(email_message, 'sign the merchant agreement', 'sign the {{agreement}}');
