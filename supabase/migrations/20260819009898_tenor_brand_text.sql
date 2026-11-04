-- Tenor rebrand: the company's name in the words the CRM itself holds.
--
-- Only text the CRM says on its own behalf. Deliberately left alone:
--   * client records, messages, mail and imported residual lines: their history;
--   * residual_partners.name: it names who the processor's statements were for;
--   * tapdash.co/discover, urgent@tapdash.co and the voicemail inbox in the phone
--     prompts and ivr_settings: real addresses, until the client names Tenor's;
--   * the SMS consent wording: filed with the carriers, see lib/sms/consentText.ts.
-- Text only, no keys, so the code deployed before this keeps working.

update agreement_settings set requester_name = 'Tenor Payments' where requester_name = 'TapDash';
alter table agreement_settings alter column requester_name set default 'Tenor Payments';

update ivr_prompts
   set body = replace(replace(body, 'TapDash Payments', 'Tenor Payments'), 'choosing TapDash', 'choosing Tenor'),
       updated_at = now()
 where body like '%TapDash%';

update residual_verdict_tolerances set label = replace(label, 'tapdash net', 'Tenor net') where label like '%tapdash net%';
update residual_buy_rate_schedules set notes = replace(notes, 'TapDash pays', 'Tenor pays') where notes like '%TapDash pays%';
