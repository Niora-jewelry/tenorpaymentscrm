-- Client, 4 Nov 2026: "Remove these fields" from Merchant Setup › Merchant Pricing.
--
-- Archived exactly as Presets' Archive does it (only archived_at), so each can be
-- restored there. Values are kept on purpose: the two monthly fees hold values on
-- existing merchants and feed the residual rates, where they stay editable.

update fields
   set archived_at = now()
 where key in (
         'td_gateway_monthly_mav',
         'td_gateway_setup_mav',
         'td_gateway_per_update_mav',
         'td_terminal_monthly_mav',
         'td_terminal_setup_mav'
       )
   and archived_at is null;
