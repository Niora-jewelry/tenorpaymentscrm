-- Client, 5 Nov 2026: "remove these", the rest of Merchant Gateway and Merchant
-- Terminal on Merchant Setup › Merchant Pricing. Part 9899 took the other five.
--
-- Archived exactly as Presets' Archive does it (only archived_at), so each can be
-- restored there, and the two section headings go with their last fields. Values are
-- kept on purpose: the two providers feed the residual rates, where they stay editable.
--
-- The Maverick agreement stops printing the two providers in the same change
-- (`EQUIPMENT_KEYS`), so nothing goes on a signed form that nobody can see on the record.

update fields
   set archived_at = now()
 where key in (
         'td_gateway_provider_mav',
         'td_gateway_per_item_mav',
         'td_gateway_auth_fee_mav',
         'td_terminal_provider_mav',
         'td_terminal_per_item_mav',
         'td_terminal_auth_fee_mav'
       )
   and archived_at is null;
