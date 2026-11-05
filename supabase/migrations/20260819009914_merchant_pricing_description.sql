-- Part 9912 removed the last of Merchant Gateway and Merchant Terminal from Merchant
-- Pricing. The sub-tab's description still promised them.

update subtabs
   set description = replace(description, ', the merchant gateway and terminal,', ',')
 where key = 'td_merchant'
   and description like '%, the merchant gateway and terminal,%';
