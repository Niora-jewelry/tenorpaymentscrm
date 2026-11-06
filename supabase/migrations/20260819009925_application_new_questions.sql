-- The online application now asks these (Send Application test, 6 Nov 2026), so
-- Presets and the field tooltips should say they are on the application. Only
-- fields still marked "not on this form" move; a choice an admin made stays.

update fields
   set application_need = 'optional'
 where application_need = 'none'
   and archived_at is null
   and key in (
     'business_email', 'business_phone', 'describe_product_service', 'building_type',
     'recurring_subscription', 'when_charged', 'amex_monthly_volume',
     'ach_credits_required', 'ach_termination'
   );

-- Owner date of birth and home address are members of the Owners group.
update fields f
   set repeat_schema = (
     select jsonb_agg(
              case when m ->> 'key' in ('dob', 'address') and coalesce(m ->> 'application_need', 'none') = 'none'
                   then m || '{"application_need": "optional"}'::jsonb
                   else m end
              order by ord)
       from jsonb_array_elements(f.repeat_schema) with ordinality as e(m, ord)
   )
 where f.key = 'owner_ownership'
   and f.archived_at is null;
